-- Euro tournaments: tickets split into an organisation fee and a prize-pool
-- contribution, a separate pool per tournament, and payouts by final placing.
-- Run reconciliation queued by earlier wallet inserts before altering the table
-- (the migrator applies pending files in one transaction).
SET CONSTRAINTS wallet_account_reconciled IMMEDIATE;
SET CONSTRAINTS wallet_account_reconciled DEFERRED;
ALTER TABLE wallet_accounts DROP CONSTRAINT wallet_accounts_kind_check;
ALTER TABLE wallet_accounts ADD CONSTRAINT wallet_accounts_kind_check
  CHECK (kind IN ('available','reserved','withdrawal_pending','external','house_revenue','prize_pool','house_reserve','house_match',
                  'tournament_pool','tournament_fees'));
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('deposit','withdrawal_hold','withdrawal_release','withdrawal_paid','stake_reserve','stake_release','stake_commit','settle',
                  'capital_in','capital_out','house_stake','house_settle',
                  'tournament_entry','tournament_refund','tournament_start','tournament_payout'));

CREATE TABLE tournaments (
  id uuid PRIMARY KEY,
  game_id text NOT NULL CHECK (game_id IN ('chess','tichu','biriba','thanasis','koumkan','diloti','xeri')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  entry_fee_minor bigint NOT NULL CHECK (entry_fee_minor >= 0),
  contribution_minor bigint NOT NULL CHECK (contribution_minor > 0),
  min_players integer NOT NULL CHECK (min_players >= 2),
  max_players integer NOT NULL CHECK (max_players <= 10000),
  starts_at timestamptz NOT NULL,
  cancellation_policy text NOT NULL CHECK (length(cancellation_policy) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','running','completed','cancelled')),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  start_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  payout_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  CHECK (max_players >= min_players),
  CHECK (entry_fee_minor + contribution_minor <= 100000000),
  CHECK ((status = 'completed') = (payout_transaction_id IS NOT NULL))
);
CREATE INDEX tournaments_listing ON tournaments(status, starts_at);

CREATE TABLE tournament_prize_rules (
  tournament_id uuid NOT NULL REFERENCES tournaments(id),
  place integer NOT NULL CHECK (place >= 1),
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 1 AND 10000),
  PRIMARY KEY(tournament_id, place)
);

-- Every configuration change before the start is kept.
CREATE TABLE tournament_changes (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id),
  changed_by text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 80),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tournament_changes_immutable BEFORE UPDATE OR DELETE ON tournament_changes
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

CREATE TABLE tournament_tickets (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  contribution_minor bigint NOT NULL CHECK (contribution_minor > 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','cancelled','refunded','settled')),
  purchase_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  refund_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('cancelled','refunded')) = (refund_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX tournament_tickets_one_active ON tournament_tickets(tournament_id, user_id) WHERE state = 'active';
CREATE INDEX tournament_tickets_user ON tournament_tickets(user_id, created_at DESC);

CREATE TABLE tournament_results (
  tournament_id uuid NOT NULL REFERENCES tournaments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  place integer NOT NULL CHECK (place >= 1),
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  PRIMARY KEY(tournament_id, user_id),
  UNIQUE(tournament_id, place)
);
CREATE TRIGGER tournament_results_immutable BEFORE UPDATE OR DELETE ON tournament_results
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

CREATE FUNCTION tournament_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tournaments are permanent' USING ERRCODE='23514';
  END IF;
  IF OLD.status <> 'open' AND (NEW.game_id,NEW.name,NEW.entry_fee_minor,NEW.contribution_minor,NEW.min_players,NEW.max_players,NEW.starts_at,NEW.cancellation_policy)
     IS DISTINCT FROM (OLD.game_id,OLD.name,OLD.entry_fee_minor,OLD.contribution_minor,OLD.min_players,OLD.max_players,OLD.starts_at,OLD.cancellation_policy) THEN
    RAISE EXCEPTION 'Tournament configuration is frozen after the start' USING ERRCODE='23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('running','cancelled')) OR
       (OLD.status = 'running' AND NEW.status IN ('completed','cancelled'))) THEN
    RAISE EXCEPTION 'Invalid tournament transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tournament_guard BEFORE UPDATE OR DELETE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION tournament_guard();

CREATE FUNCTION tournament_ticket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id,NEW.tournament_id,NEW.user_id,NEW.fee_minor,NEW.contribution_minor,NEW.purchase_transaction_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.tournament_id,OLD.user_id,OLD.fee_minor,OLD.contribution_minor,OLD.purchase_transaction_id,OLD.created_at)
     OR (NEW.state <> OLD.state AND NOT (OLD.state = 'active' AND NEW.state IN ('cancelled','refunded','settled'))) THEN
    RAISE EXCEPTION 'Ticket contract is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tournament_ticket_guard BEFORE UPDATE OR DELETE ON tournament_tickets
  FOR EACH ROW EXECUTE FUNCTION tournament_ticket_guard();

-- Prize shares are contiguous places summing to 100%, no more places than the
-- minimum field, and a completed tournament paid out exactly its pool.
CREATE FUNCTION tournament_reconciled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; t tournaments%ROWTYPE; places integer; total bigint;
BEGIN
  IF TG_TABLE_NAME = 'tournaments' THEN tid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN tid := OLD.tournament_id;
  ELSE tid := NEW.tournament_id; END IF;
  SELECT * INTO t FROM tournaments WHERE id = tid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(basis_points),0) INTO places, total FROM tournament_prize_rules WHERE tournament_id = t.id;
  IF total <> 10000 OR places > t.min_players
     OR places <> (SELECT coalesce(max(place),0) FROM tournament_prize_rules WHERE tournament_id = t.id) THEN
    RAISE EXCEPTION 'Tournament prize rules do not reconcile' USING ERRCODE='23514';
  END IF;
  IF t.status = 'completed' AND (
       (SELECT coalesce(sum(payout_minor),0) FROM tournament_results WHERE tournament_id = t.id)
         <> (SELECT coalesce(sum(contribution_minor),0) FROM tournament_tickets WHERE tournament_id = t.id AND state = 'settled')
       OR EXISTS(SELECT 1 FROM tournament_tickets WHERE tournament_id = t.id AND state = 'active')
       OR (SELECT count(*) FROM tournament_results WHERE tournament_id = t.id)
         <> (SELECT count(*) FROM tournament_tickets WHERE tournament_id = t.id AND state = 'settled')
       OR (SELECT balance_minor FROM wallet_accounts WHERE key = 'tournament_pool:'||t.id) <> 0) THEN
    RAISE EXCEPTION 'Tournament payout does not reconcile' USING ERRCODE='23514';
  END IF;
  IF t.status = 'cancelled' AND EXISTS(SELECT 1 FROM tournament_tickets WHERE tournament_id = t.id AND state IN ('active','settled')) THEN
    RAISE EXCEPTION 'Cancelled tournament has unrefunded tickets' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER tournament_reconciled AFTER INSERT OR UPDATE ON tournaments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tournament_reconciled();
CREATE CONSTRAINT TRIGGER tournament_prize_rules_reconciled AFTER INSERT OR UPDATE OR DELETE ON tournament_prize_rules
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tournament_reconciled();
-- Prize shares are part of the frozen configuration once play starts.
CREATE FUNCTION tournament_rules_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM tournaments WHERE id = OLD.tournament_id) <> 'open' THEN
    RAISE EXCEPTION 'Tournament prize rules are frozen after the start' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tournament_rules_frozen BEFORE UPDATE OR DELETE ON tournament_prize_rules
  FOR EACH ROW EXECUTE FUNCTION tournament_rules_frozen();
