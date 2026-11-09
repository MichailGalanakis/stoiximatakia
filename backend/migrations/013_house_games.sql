-- Server-side games against platform bots, one per house match. Seat 0 is the
-- player; every other seat is a bot. Moves are recorded for replay and audit.
CREATE TABLE house_games (
  match_id uuid PRIMARY KEY REFERENCES house_matches(id),
  format_id text NOT NULL,
  engine_version text NOT NULL,
  rules_version text NOT NULL,
  players text[] NOT NULL CHECK (cardinality(players) IN (2,4)),
  state jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  bot_random_state bigint NOT NULL CHECK (bot_random_state BETWEEN 0 AND 4294967295),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE house_game_events (
  match_id uuid NOT NULL REFERENCES house_games(match_id),
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('start','action','forfeit')),
  actor text NOT NULL,
  action jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(match_id, revision),
  CHECK ((kind = 'start') = (revision = 1)),
  CHECK ((kind = 'action') = (action IS NOT NULL))
);
CREATE TRIGGER house_game_events_immutable BEFORE UPDATE OR DELETE ON house_game_events
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

CREATE FUNCTION house_game_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.match_id,NEW.format_id,NEW.engine_version,NEW.rules_version,NEW.players)
     IS DISTINCT FROM (OLD.match_id,OLD.format_id,OLD.engine_version,OLD.rules_version,OLD.players)
     OR NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'House game history must only advance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER house_game_guard BEFORE UPDATE OR DELETE ON house_games
  FOR EACH ROW EXECUTE FUNCTION house_game_guard();

-- The stored revision always equals the recorded history.
CREATE FUNCTION house_game_reconciled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g house_games%ROWTYPE;
BEGIN
  SELECT * INTO g FROM house_games WHERE match_id = NEW.match_id;
  IF g.revision <> (SELECT count(*) FROM house_game_events WHERE match_id = g.match_id)
     OR g.revision <> (SELECT max(revision) FROM house_game_events WHERE match_id = g.match_id) THEN
    RAISE EXCEPTION 'House game history does not reconcile' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER house_game_reconciled AFTER INSERT OR UPDATE ON house_games
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION house_game_reconciled();
CREATE CONSTRAINT TRIGGER house_game_event_reconciled AFTER INSERT ON house_game_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION house_game_reconciled();
