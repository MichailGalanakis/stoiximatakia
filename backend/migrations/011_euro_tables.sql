-- Euro-funded tables. A table's currency is fixed at creation: credit tables keep
-- using the demo credit ledger, euro tables use the wallet ledger (migration 010).
ALTER TABLE game_tables ADD COLUMN currency text NOT NULL DEFAULT 'credits'
  CHECK (currency IN ('credits','EUR'));
CREATE INDEX game_tables_public_currency ON game_tables(game_id,currency,created_at DESC) WHERE visibility='public';

CREATE OR REPLACE FUNCTION table_config_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.creator_id,NEW.game_id,NEW.name,NEW.visibility,NEW.code_hash,NEW.format_id,NEW.capacity,NEW.entry_fee_minor,NEW.contribution_minor,NEW.created_at,NEW.currency)
     IS DISTINCT FROM
     (OLD.id,OLD.creator_id,OLD.game_id,OLD.name,OLD.visibility,OLD.code_hash,OLD.format_id,OLD.capacity,OLD.entry_fee_minor,OLD.contribution_minor,OLD.created_at,OLD.currency) THEN
    RAISE EXCEPTION 'Table configuration is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('deposit','withdrawal_hold','withdrawal_release','withdrawal_paid','stake_reserve','stake_release','stake_commit','settle'));

-- Exactly one ledger records each settlement, matching the table's currency.
ALTER TABLE match_settlements ALTER COLUMN journal_id DROP NOT NULL;
ALTER TABLE match_settlements ADD COLUMN wallet_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id);
ALTER TABLE match_settlements ADD CONSTRAINT match_settlements_one_ledger
  CHECK (num_nonnulls(journal_id, wallet_transaction_id) = 1);

-- Same invariants as migration 008, with the ledger chosen by the table currency.
CREATE OR REPLACE FUNCTION match_reconciled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; g table_games%ROWTYPE; t game_tables%ROWTYPE; r match_results%ROWTYPE; s match_settlements%ROWTYPE;
  pool_amount integer; fees integer; refunded boolean; winners integer; euro boolean; pool_balance bigint;
BEGIN
  IF TG_TABLE_NAME='game_tables' THEN tid:=NEW.id;
  ELSIF TG_OP='DELETE' THEN tid:=OLD.table_id; ELSE tid:=NEW.table_id; END IF;
  SELECT * INTO g FROM table_games WHERE table_id=tid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO t FROM game_tables WHERE id=tid;
  euro:=t.currency='EUR';
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
  IF euro THEN
    SELECT balance_minor INTO pool_balance FROM wallet_accounts WHERE key='prize_pool:'||tid;
  ELSE
    SELECT balance_minor INTO pool_balance FROM credit_accounts WHERE key='pool:'||tid;
  END IF;
  SELECT * INTO s FROM match_settlements WHERE table_id=tid;
  IF NOT FOUND OR s.result_id<>r.id OR r.game_revision<>g.revision
    OR euro<>(s.wallet_transaction_id IS NOT NULL)
    OR t.status<>(CASE WHEN refunded THEN 'cancelled' ELSE 'completed' END)
    OR (r.kind='cancel' AND g.accepted_gameplay_count<>0)
    OR EXISTS(SELECT 1 FROM table_participations WHERE table_id=tid)
    OR EXISTS(SELECT 1 FROM match_roster m JOIN table_tickets k ON k.id=m.ticket_id WHERE m.table_id=tid AND k.state<>CASE WHEN refunded THEN 'refunded' ELSE 'settled' END)
    OR s.total_paid_minor<>pool_amount+(CASE WHEN refunded THEN fees ELSE 0 END)
    OR s.fee_returned_minor<>(CASE WHEN refunded THEN fees ELSE 0 END)
    OR pool_balance<>0 THEN
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
         WHEN refunded THEN t.contribution_minor+t.entry_fee_minor ELSE t.contribution_minor END)) THEN
    RAISE EXCEPTION 'Match payout policy does not reconcile' USING ERRCODE='23514';
  END IF;
  IF euro THEN
    IF NOT EXISTS(SELECT 1 FROM ledger_transactions WHERE id=s.wallet_transaction_id AND kind='settle' AND operation_key='settle:'||r.id AND reference_id=r.id::text)
      OR (SELECT count(*) FROM ledger_entries WHERE transaction_id=s.wallet_transaction_id)<>(SELECT count(*) FROM match_allocations WHERE result_id=r.id AND amount_minor>0)+1+(CASE WHEN refunded THEN 1 ELSE 0 END)
      OR NOT EXISTS(SELECT 1 FROM ledger_entries WHERE transaction_id=s.wallet_transaction_id AND account_key='prize_pool:'||tid AND amount_minor=-pool_amount)
      OR (refunded AND NOT EXISTS(SELECT 1 FROM ledger_entries WHERE transaction_id=s.wallet_transaction_id AND account_key='house_revenue' AND amount_minor=-fees))
      OR EXISTS(SELECT 1 FROM match_allocations a WHERE a.result_id=r.id AND a.amount_minor>0 AND NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.transaction_id=s.wallet_transaction_id AND e.account_key='available:'||a.user_id AND e.amount_minor=a.amount_minor)) THEN
      RAISE EXCEPTION 'Match payout policy does not reconcile' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM credit_journals WHERE id=s.journal_id AND kind='settle' AND operation_key='settle:'||r.id AND reference_id=r.id::text)
    OR (SELECT count(*) FROM credit_postings WHERE journal_id=s.journal_id)<>(SELECT count(*) FROM match_allocations WHERE result_id=r.id AND amount_minor>0)+1+(CASE WHEN refunded THEN 1 ELSE 0 END)
    OR NOT EXISTS(SELECT 1 FROM credit_postings WHERE journal_id=s.journal_id AND account_key='pool:'||tid AND amount_minor=-pool_amount)
    OR (refunded AND NOT EXISTS(SELECT 1 FROM credit_postings WHERE journal_id=s.journal_id AND account_key='fees' AND amount_minor=-fees))
    OR EXISTS(SELECT 1 FROM match_allocations a WHERE a.result_id=r.id AND a.amount_minor>0 AND NOT EXISTS(SELECT 1 FROM credit_postings p WHERE p.journal_id=s.journal_id AND p.account_key='available:'||a.user_id AND p.amount_minor=a.amount_minor)) THEN
    RAISE EXCEPTION 'Match payout policy does not reconcile' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
