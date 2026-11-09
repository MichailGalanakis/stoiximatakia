-- Player-vs-platform matches: a fixed prize paid by the company, backed by a
-- reserve that is kept apart from customer balances.
-- The migrator applies pending files in one transaction; run the reconciliation
-- queued by migration 010 now, because ALTER TABLE refuses pending trigger events.
SET CONSTRAINTS wallet_account_reconciled IMMEDIATE;
SET CONSTRAINTS wallet_account_reconciled DEFERRED;
ALTER TABLE wallet_accounts DROP CONSTRAINT wallet_accounts_kind_check;
ALTER TABLE wallet_accounts ADD CONSTRAINT wallet_accounts_kind_check
  CHECK (kind IN ('available','reserved','withdrawal_pending','external','house_revenue','prize_pool','house_reserve','house_match'));
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('deposit','withdrawal_hold','withdrawal_release','withdrawal_paid','stake_reserve','stake_release','stake_commit','settle',
                  'capital_in','capital_out','house_stake','house_settle'));
-- Company capital enters through external:company and backs the reserve.
INSERT INTO wallet_accounts(key,kind) VALUES ('house_reserve','house_reserve'),('external:company','external');

-- Audit trail for every capital movement into or out of the reserve.
CREATE TABLE house_capital_movements (
  id uuid PRIMARY KEY,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reviewer text NOT NULL CHECK (length(reviewer) BETWEEN 1 AND 80),
  note text CHECK (length(note) <= 500),
  transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER house_capital_movements_immutable BEFORE UPDATE OR DELETE ON house_capital_movements
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

CREATE TABLE house_offers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,40}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  prize_minor bigint NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (prize_minor > stake_minor AND prize_minor <= 100 * stake_minor)
);
-- Prices are a published contract: only availability may change.
CREATE FUNCTION house_offer_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id,NEW.stake_minor,NEW.prize_minor,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.stake_minor,OLD.prize_minor,OLD.created_at) THEN
    RAISE EXCEPTION 'House offer terms are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER house_offer_frozen BEFORE UPDATE OR DELETE ON house_offers
  FOR EACH ROW EXECUTE FUNCTION house_offer_frozen();
INSERT INTO house_offers(id,stake_minor,prize_minor) VALUES ('stake-5-prize-8',500,800);

CREATE TABLE house_matches (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  offer_id text NOT NULL REFERENCES house_offers(id),
  game_id text NOT NULL CHECK (game_id IN ('chess','tichu','biriba','thanasis','koumkan','diloti','xeri')),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  prize_minor bigint NOT NULL CHECK (prize_minor > stake_minor),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','won','lost','void')),
  stake_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  settle_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((status = 'active') = (settle_transaction_id IS NULL)),
  CHECK ((status = 'active') = (settled_at IS NULL))
);
CREATE UNIQUE INDEX house_matches_one_active ON house_matches(user_id) WHERE status = 'active';
CREATE INDEX house_matches_user ON house_matches(user_id, created_at DESC);

CREATE FUNCTION house_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id,NEW.user_id,NEW.offer_id,NEW.game_id,NEW.stake_minor,NEW.prize_minor,NEW.stake_transaction_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.offer_id,OLD.game_id,OLD.stake_minor,OLD.prize_minor,OLD.stake_transaction_id,OLD.created_at)
     OR OLD.status <> 'active' OR NEW.status NOT IN ('won','lost','void') THEN
    RAISE EXCEPTION 'House match is immutable once settled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER house_match_guard BEFORE UPDATE OR DELETE ON house_matches
  FOR EACH ROW EXECUTE FUNCTION house_match_guard();
