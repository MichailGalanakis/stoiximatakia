-- Real-money euro wallet. Deliberately separate from the demo credit_* ledger:
-- no posting, account or journal can move value between the two.
CREATE TABLE wallet_accounts (
  key text PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('available','reserved','withdrawal_pending','external','house_revenue','prize_pool')),
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CHECK ((kind IN ('available','reserved','withdrawal_pending')) = (user_id IS NOT NULL)),
  -- Only provider settlement accounts mirror money held outside the platform.
  CHECK (kind = 'external' OR balance_minor >= 0),
  UNIQUE(user_id, kind)
);
CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('deposit','withdrawal_hold','withdrawal_release','withdrawal_paid','stake_reserve','stake_release','settle')),
  reference_id text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_key text NOT NULL REFERENCES wallet_accounts(key),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY(transaction_id, account_key)
);
CREATE INDEX ledger_entries_account ON ledger_entries(account_key);

CREATE FUNCTION wallet_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Wallet history is append only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

CREATE FUNCTION wallet_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet_accounts SET balance_minor=balance_minor+NEW.amount_minor WHERE key=NEW.account_key;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entry_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_apply_entry();

CREATE FUNCTION wallet_check_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx uuid;
BEGIN
  IF TG_TABLE_NAME='ledger_transactions' THEN tx:=NEW.id; ELSE tx:=NEW.transaction_id; END IF;
  IF (SELECT count(*) < 2 OR sum(amount_minor) <> 0 FROM ledger_entries WHERE transaction_id=tx) THEN
    RAISE EXCEPTION 'Unbalanced wallet transaction' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transaction_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_check_transaction();
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_check_transaction();

CREATE FUNCTION wallet_check_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT balance_minor FROM wallet_accounts WHERE key=NEW.key) <>
     (SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE account_key=NEW.key) THEN
    RAISE EXCEPTION 'Wallet projection does not reconcile' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER wallet_account_reconciled AFTER INSERT OR UPDATE ON wallet_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_check_account();

INSERT INTO wallet_accounts(key,kind) VALUES ('house_revenue','house_revenue'),('external:sandbox','external');
INSERT INTO wallet_accounts(key,user_id,kind)
  SELECT k.prefix||u.id, u.id, k.kind FROM users u
  CROSS JOIN (VALUES ('available:','available'),('reserved:','reserved'),('withdrawal_pending:','withdrawal_pending')) AS k(prefix,kind);
-- New accounts start at zero euros; demo credits keep their own opening grant.
CREATE FUNCTION wallet_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallet_accounts(key,user_id,kind) VALUES
    ('available:'||NEW.id,NEW.id,'available'),
    ('reserved:'||NEW.id,NEW.id,'reserved'),
    ('withdrawal_pending:'||NEW.id,NEW.id,'withdrawal_pending');
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_user_created AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION wallet_new_user();

CREATE TABLE deposits (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  provider_reference text,
  transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'succeeded') = (transaction_id IS NOT NULL)),
  UNIQUE(provider, provider_reference)
);
CREATE INDEX deposits_user ON deposits(user_id, created_at DESC);

CREATE TABLE withdrawal_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','processing','paid','rejected','cancelled','failed')),
  hold_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  final_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  provider_reference text,
  reviewed_by text,
  review_note text CHECK (length(review_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('requested','processing')) = (final_transaction_id IS NULL)),
  CHECK (status NOT IN ('processing','paid','failed') OR provider_reference IS NOT NULL),
  UNIQUE(provider, provider_reference)
);
CREATE INDEX withdrawal_requests_user ON withdrawal_requests(user_id, created_at DESC);
CREATE INDEX withdrawal_requests_open ON withdrawal_requests(status) WHERE status IN ('requested','processing');

-- Money rows can only move forward through their published lifecycle.
CREATE FUNCTION wallet_guard_payment_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.provider <> OLD.provider
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'Payment identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME = 'deposits' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'Deposit is final' USING ERRCODE='23514';
    END IF;
  ELSIF NOT ((OLD.status = 'requested' AND NEW.status IN ('processing','rejected','cancelled'))
          OR (OLD.status = 'processing' AND NEW.status IN ('paid','failed'))) THEN
    RAISE EXCEPTION 'Invalid withdrawal transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deposits_status_guard BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION wallet_guard_payment_status();
CREATE TRIGGER withdrawal_requests_status_guard BEFORE UPDATE ON withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION wallet_guard_payment_status();
CREATE TRIGGER deposits_no_delete BEFORE DELETE ON deposits
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE TRIGGER withdrawal_requests_no_delete BEFORE DELETE ON withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

-- Verified provider notifications, stored once per provider event ID.
CREATE TABLE provider_events (
  provider text NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, event_id)
);
CREATE TRIGGER provider_events_immutable BEFORE UPDATE OR DELETE ON provider_events
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

CREATE TABLE wallet_operations (
  user_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, operation_id)
);
