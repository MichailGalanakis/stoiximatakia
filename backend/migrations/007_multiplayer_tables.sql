CREATE TABLE game_tables (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES users(id),
  game_id text NOT NULL CHECK (game_id IN ('chess','tichu','biriba','thanasis','koumkan','diloti','xeri')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 48),
  visibility text NOT NULL CHECK (visibility IN ('public','private')),
  code_hash text,
  format_id text NOT NULL,
  capacity integer NOT NULL CHECK (capacity IN (2,4)),
  entry_fee_minor integer NOT NULL CHECK (entry_fee_minor=90),
  contribution_minor integer NOT NULL CHECK (contribution_minor IN (100,500,1500,3000)),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','completed','cancelled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  CHECK ((visibility='private') = (code_hash IS NOT NULL)),
  CHECK (capacity=CASE WHEN game_id IN ('tichu','biriba') THEN 4 ELSE 2 END)
);
CREATE UNIQUE INDEX game_tables_code_hash_key ON game_tables(code_hash) WHERE status IN ('waiting','playing');
CREATE TABLE table_access (
  table_id uuid NOT NULL REFERENCES game_tables(id),
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY(table_id,user_id)
);
CREATE TABLE table_tickets (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES game_tables(id),
  user_id uuid NOT NULL REFERENCES users(id),
  fee_minor integer NOT NULL CHECK (fee_minor=90),
  contribution_minor integer NOT NULL CHECK (contribution_minor IN (100,500,1500,3000)),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','committed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,table_id,user_id)
);
CREATE TABLE table_participations (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  table_id uuid NOT NULL REFERENCES game_tables(id),
  seat_index integer NOT NULL CHECK (seat_index BETWEEN 0 AND 3),
  ticket_id uuid NOT NULL UNIQUE,
  ready boolean NOT NULL DEFAULT false,
  UNIQUE(table_id,seat_index),
  FOREIGN KEY(ticket_id,table_id,user_id) REFERENCES table_tickets(id,table_id,user_id)
);
CREATE TABLE platform_operations (
  user_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE table_games (
  table_id uuid PRIMARY KEY REFERENCES game_tables(id),
  rules_version text NOT NULL,
  state jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0)
);
CREATE TABLE table_access_limits (
  key text PRIMARY KEY,
  bucket timestamptz NOT NULL,
  attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 20)
);
CREATE INDEX game_tables_public ON game_tables(game_id,created_at DESC) WHERE visibility='public';
CREATE INDEX tickets_owner ON table_tickets(user_id,created_at DESC);
-- Creation snapshots define the financial contract; later state transitions
-- cannot silently alter a price, participant, game format, or issued receipt.
CREATE FUNCTION table_config_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.creator_id,NEW.game_id,NEW.name,NEW.visibility,NEW.code_hash,NEW.format_id,NEW.capacity,NEW.entry_fee_minor,NEW.contribution_minor,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.creator_id,OLD.game_id,OLD.name,OLD.visibility,OLD.code_hash,OLD.format_id,OLD.capacity,OLD.entry_fee_minor,OLD.contribution_minor,OLD.created_at) THEN
    RAISE EXCEPTION 'Table configuration is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER table_config_frozen BEFORE UPDATE ON game_tables
  FOR EACH ROW EXECUTE FUNCTION table_config_frozen();
CREATE FUNCTION ticket_contract_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.table_id,NEW.user_id,NEW.fee_minor,NEW.contribution_minor,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.table_id,OLD.user_id,OLD.fee_minor,OLD.contribution_minor,OLD.created_at)
     OR (NEW.state<>OLD.state AND NOT (OLD.state='reserved' AND NEW.state IN ('committed','cancelled'))) THEN
    RAISE EXCEPTION 'Ticket contract is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ticket_contract_frozen BEFORE UPDATE ON table_tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_contract_frozen();
CREATE TRIGGER ticket_history_preserved BEFORE DELETE ON table_tickets
  FOR EACH ROW EXECUTE FUNCTION credit_immutable();
