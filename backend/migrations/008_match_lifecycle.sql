-- Shared lifecycle. Applied migrations 006/007 remain unchanged.
ALTER TABLE table_games ADD COLUMN accepted_gameplay_count integer NOT NULL DEFAULT 0 CHECK (accepted_gameplay_count>=0);
ALTER TABLE table_games ADD COLUMN engine_version text NOT NULL DEFAULT 'initialization-only';

CREATE TABLE match_roster (
  table_id uuid NOT NULL REFERENCES table_games(table_id),
  user_id uuid NOT NULL,
  seat_index integer NOT NULL CHECK (seat_index BETWEEN 0 AND 3),
  ticket_id uuid NOT NULL UNIQUE,
  PRIMARY KEY(table_id,user_id),
  UNIQUE(table_id,seat_index),
  FOREIGN KEY(ticket_id,table_id,user_id) REFERENCES table_tickets(id,table_id,user_id)
);
CREATE TABLE match_events (
  table_id uuid NOT NULL REFERENCES table_games(table_id),
  revision integer NOT NULL CHECK (revision>0),
  kind text NOT NULL CHECK(kind IN ('start','action','forfeit','cancel','void')),
  CHECK ((kind='start')=(revision=1)),
  gameplay boolean NOT NULL DEFAULT false CHECK (NOT gameplay OR kind='action'),
  actor_user_id uuid REFERENCES users(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(table_id,revision)
);
-- Before this increment no game actions/results existed; active starts can be
-- backfilled exactly from funded participation without inventing any moves.
INSERT INTO match_roster(table_id,user_id,seat_index,ticket_id)
  SELECT p.table_id,p.user_id,p.seat_index,p.ticket_id FROM table_participations p JOIN table_games g ON g.table_id=p.table_id;
INSERT INTO match_events(table_id,revision,kind,payload)
  SELECT table_id,1,'start',jsonb_build_object('source','migration-008','engineVersion',engine_version,'rulesVersion',rules_version,'initialState',state) FROM table_games;

CREATE TABLE match_results (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL UNIQUE REFERENCES table_games(table_id),
  game_revision integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('win','draw','cancel','void')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 128),
  winner_ids uuid[] NOT NULL,
  source text NOT NULL CHECK(source IN ('engine','participant','backend')),
  actor_user_id uuid REFERENCES users(id),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='win')=(cardinality(winner_ids)>0)),
  CHECK ((source='participant')=(actor_user_id IS NOT NULL) OR source='engine'),
  FOREIGN KEY(table_id,game_revision) REFERENCES match_events(table_id,revision),
  UNIQUE(id,table_id)
);
CREATE TABLE match_settlements (
  result_id uuid PRIMARY KEY,
  table_id uuid NOT NULL UNIQUE,
  journal_id uuid NOT NULL UNIQUE REFERENCES credit_journals(id),
  total_paid_minor integer NOT NULL CHECK(total_paid_minor>0),
  fee_returned_minor integer NOT NULL CHECK(fee_returned_minor>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(result_id,table_id) REFERENCES match_results(id,table_id)
);
CREATE TABLE match_allocations (
  result_id uuid NOT NULL REFERENCES match_settlements(result_id),
  table_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount_minor integer NOT NULL CHECK(amount_minor>=0),
  PRIMARY KEY(result_id,user_id),
  FOREIGN KEY(table_id,user_id) REFERENCES match_roster(table_id,user_id),
  FOREIGN KEY(result_id,table_id) REFERENCES match_results(id,table_id)
);
CREATE TABLE match_backend_operations (
  operation_id uuid PRIMARY KEY,
  fingerprint text NOT NULL,
  response jsonb NOT NULL
);

ALTER TABLE table_tickets DROP CONSTRAINT table_tickets_state_check;
ALTER TABLE table_tickets ADD CONSTRAINT table_tickets_state_check CHECK(state IN ('reserved','committed','cancelled','settled','refunded'));
CREATE OR REPLACE FUNCTION ticket_contract_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.table_id,NEW.user_id,NEW.fee_minor,NEW.contribution_minor,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.table_id,OLD.user_id,OLD.fee_minor,OLD.contribution_minor,OLD.created_at)
     OR (NEW.state<>OLD.state AND NOT (
       (OLD.state='reserved' AND NEW.state IN ('committed','cancelled')) OR
       (OLD.state='committed' AND NEW.state IN ('settled','refunded')))) THEN
    RAISE EXCEPTION 'Ticket contract is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER match_roster_immutable BEFORE UPDATE OR DELETE ON match_roster FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER match_event_immutable BEFORE UPDATE OR DELETE ON match_events FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER match_result_immutable BEFORE UPDATE OR DELETE ON match_results FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER match_settlement_immutable BEFORE UPDATE OR DELETE ON match_settlements FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER match_allocation_immutable BEFORE UPDATE OR DELETE ON match_allocations FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER match_backend_operation_immutable BEFORE UPDATE OR DELETE ON match_backend_operations FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER platform_operation_immutable BEFORE UPDATE OR DELETE ON platform_operations FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE FUNCTION match_game_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Game history is permanent' USING ERRCODE='23514'; END IF;
  IF (NEW.table_id,NEW.rules_version,NEW.engine_version) IS DISTINCT FROM (OLD.table_id,OLD.rules_version,OLD.engine_version)
    OR NEW.revision<>OLD.revision+1 OR NEW.accepted_gameplay_count NOT BETWEEN OLD.accepted_gameplay_count AND OLD.accepted_gameplay_count+1 THEN
    RAISE EXCEPTION 'Game version/history must advance monotonically' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER match_game_monotonic BEFORE UPDATE OR DELETE ON table_games FOR EACH ROW EXECUTE FUNCTION match_game_monotonic();

-- Deferred invariants reject partial results, payments, history or roster release.
CREATE FUNCTION match_reconciled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; g table_games%ROWTYPE; t game_tables%ROWTYPE; r match_results%ROWTYPE; s match_settlements%ROWTYPE;
  pool_amount integer; fees integer; refunded boolean; winners integer;
BEGIN
  IF TG_TABLE_NAME='game_tables' THEN tid:=NEW.id;
  ELSIF TG_OP='DELETE' THEN tid:=OLD.table_id; ELSE tid:=NEW.table_id; END IF;
  SELECT * INTO g FROM table_games WHERE table_id=tid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO t FROM game_tables WHERE id=tid;
  IF (SELECT count(*) FROM match_roster WHERE table_id=tid)<>t.capacity
    OR g.revision<>(SELECT count(*) FROM match_events WHERE table_id=tid)
    OR g.revision<>(SELECT max(revision) FROM match_events WHERE table_id=tid)
    OR g.accepted_gameplay_count<>(SELECT count(*) FROM match_events WHERE table_id=tid AND gameplay) THEN
    RAISE EXCEPTION 'Match roster/history does not reconcile' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM match_results WHERE table_id=tid;
  IF NOT FOUND THEN
    IF t.status<>'playing' OR EXISTS(SELECT 1 FROM match_settlements WHERE table_id=tid)
      OR (SELECT count(*) FROM table_participations WHERE table_id=tid)<>t.capacity
      OR EXISTS(SELECT 1 FROM match_roster m LEFT JOIN table_participations p ON p.table_id=m.table_id AND p.user_id=m.user_id WHERE m.table_id=tid AND (p.user_id IS NULL OR p.ticket_id<>m.ticket_id OR p.seat_index<>m.seat_index))
      OR EXISTS(SELECT 1 FROM match_roster m JOIN table_tickets k ON k.id=m.ticket_id WHERE m.table_id=tid AND k.state<>'committed') THEN
      RAISE EXCEPTION 'Active match funding/participation does not reconcile' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  pool_amount:=t.capacity*t.contribution_minor; fees:=t.capacity*t.entry_fee_minor;
  refunded:=r.kind IN ('cancel','void'); winners:=cardinality(r.winner_ids);
  SELECT * INTO s FROM match_settlements WHERE table_id=tid;
  IF NOT FOUND OR s.result_id<>r.id OR r.game_revision<>g.revision
    OR t.status<>(CASE WHEN refunded THEN 'cancelled' ELSE 'completed' END)
    OR (r.kind='cancel' AND g.accepted_gameplay_count<>0)
    OR EXISTS(SELECT 1 FROM table_participations WHERE table_id=tid)
    OR EXISTS(SELECT 1 FROM match_roster m JOIN table_tickets k ON k.id=m.ticket_id WHERE m.table_id=tid AND k.state<>CASE WHEN refunded THEN 'refunded' ELSE 'settled' END)
    OR s.total_paid_minor<>pool_amount+(CASE WHEN refunded THEN fees ELSE 0 END)
    OR s.fee_returned_minor<>(CASE WHEN refunded THEN fees ELSE 0 END)
    OR (SELECT balance_minor FROM credit_accounts WHERE key='pool:'||tid)<>0 THEN
    RAISE EXCEPTION 'Terminal match/settlement does not reconcile' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM match_events e WHERE e.table_id=tid AND e.revision=r.game_revision
    AND e.actor_user_id IS NOT DISTINCT FROM r.actor_user_id
    AND ((r.source='engine' AND e.kind='action') OR (r.source='participant' AND ((r.kind='cancel' AND e.kind='cancel') OR (r.kind='win' AND e.kind='forfeit'))) OR (r.source='backend' AND r.kind='void' AND e.kind='void'))) THEN
    RAISE EXCEPTION 'Match result source does not reconcile' USING ERRCODE='23514';
  END IF;
  IF r.kind='win' AND (winners<>(CASE WHEN t.capacity=4 THEN 2 ELSE 1 END)
    OR (SELECT count(DISTINCT x) FROM unnest(r.winner_ids) x)<>winners
    OR (SELECT count(*) FROM match_roster WHERE table_id=tid AND user_id=ANY(r.winner_ids))<>winners
    OR (t.capacity=4 AND (SELECT count(DISTINCT seat_index%2) FROM match_roster WHERE table_id=tid AND user_id=ANY(r.winner_ids))<>1)) THEN
    RAISE EXCEPTION 'Invalid winning side' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM match_allocations WHERE result_id=r.id)<>t.capacity
    OR EXISTS(SELECT 1 FROM match_allocations a WHERE a.result_id=r.id AND (a.table_id<>tid OR a.amount_minor<>
       CASE WHEN r.kind='win' THEN CASE WHEN a.user_id=ANY(r.winner_ids) THEN pool_amount/winners ELSE 0 END
         WHEN refunded THEN t.contribution_minor+t.entry_fee_minor ELSE t.contribution_minor END))
    OR NOT EXISTS(SELECT 1 FROM credit_journals WHERE id=s.journal_id AND kind='settle' AND operation_key='settle:'||r.id AND reference_id=r.id::text)
    OR (SELECT count(*) FROM credit_postings WHERE journal_id=s.journal_id)<>(SELECT count(*) FROM match_allocations WHERE result_id=r.id AND amount_minor>0)+1+(CASE WHEN refunded THEN 1 ELSE 0 END)
    OR NOT EXISTS(SELECT 1 FROM credit_postings WHERE journal_id=s.journal_id AND account_key='pool:'||tid AND amount_minor=-pool_amount)
    OR (refunded AND NOT EXISTS(SELECT 1 FROM credit_postings WHERE journal_id=s.journal_id AND account_key='fees' AND amount_minor=-fees))
    OR EXISTS(SELECT 1 FROM match_allocations a WHERE a.result_id=r.id AND a.amount_minor>0 AND NOT EXISTS(SELECT 1 FROM credit_postings p WHERE p.journal_id=s.journal_id AND p.account_key='available:'||a.user_id AND p.amount_minor=a.amount_minor)) THEN
    RAISE EXCEPTION 'Match payout policy does not reconcile' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER match_game_reconciled AFTER INSERT OR UPDATE ON table_games DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_event_reconciled AFTER INSERT ON match_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_roster_reconciled AFTER INSERT ON match_roster DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_result_reconciled AFTER INSERT ON match_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_settlement_reconciled AFTER INSERT ON match_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_allocation_reconciled AFTER INSERT ON match_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_table_reconciled AFTER UPDATE ON game_tables DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_ticket_reconciled AFTER UPDATE ON table_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
CREATE CONSTRAINT TRIGGER match_participation_reconciled AFTER INSERT OR UPDATE OR DELETE ON table_participations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION match_reconciled();
-- Validate any legacy initialization-only games during this migration too.
UPDATE game_tables SET revision=revision WHERE id IN (SELECT table_id FROM table_games);
