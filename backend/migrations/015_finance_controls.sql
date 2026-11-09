-- Finance controls: named admins with roles, an audit log of every admin action,
-- two-person balance corrections, deposit disputes and reconciliation runs.
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('deposit','withdrawal_hold','withdrawal_release','withdrawal_paid','stake_reserve','stake_release','stake_commit','settle',
                  'capital_in','capital_out','house_stake','house_settle',
                  'tournament_entry','tournament_refund','tournament_start','tournament_payout',
                  'correction','chargeback'));

CREATE TABLE admin_users (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9._-]{2,40}$' AND name <> 'root'),
  role text NOT NULL CHECK (role IN ('viewer','finance','admin')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Only deactivation is possible; a role change means a new account and token.
CREATE FUNCTION admin_user_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id,NEW.name,NEW.role,NEW.token_hash,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.name,OLD.role,OLD.token_hash,OLD.created_by,OLD.created_at)
     OR (OLD.active = false AND NEW.active = true) THEN
    RAISE EXCEPTION 'Admin accounts can only be deactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_user_guard BEFORE UPDATE OR DELETE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION admin_user_guard();

CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  target text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_recent ON admin_audit_log(created_at DESC);
CREATE TRIGGER admin_audit_log_immutable BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

CREATE TABLE balance_corrections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND abs(amount_minor) <= 100000000),
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  requested_by text NOT NULL,
  decided_by text,
  transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK ((status = 'applied') = (transaction_id IS NOT NULL)),
  -- Four-eyes rule: nobody approves their own correction.
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE FUNCTION balance_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id,NEW.user_id,NEW.amount_minor,NEW.reason,NEW.requested_by,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.amount_minor,OLD.reason,OLD.requested_by,OLD.created_at)
     OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Correction is immutable once decided' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER balance_correction_guard BEFORE UPDATE OR DELETE ON balance_corrections
  FOR EACH ROW EXECUTE FUNCTION balance_correction_guard();

CREATE TABLE deposit_disputes (
  id uuid PRIMARY KEY,
  deposit_id uuid NOT NULL REFERENCES deposits(id),
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  opened_by text NOT NULL,
  resolved_by text,
  recovered_minor bigint CHECK (recovered_minor >= 0),
  shortfall_minor bigint CHECK (shortfall_minor >= 0),
  transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'open') = (resolved_by IS NULL)),
  CHECK ((status = 'lost') = (transaction_id IS NOT NULL)),
  CHECK (status <> 'lost' OR recovered_minor + shortfall_minor = amount_minor)
);
CREATE UNIQUE INDEX deposit_disputes_one_open ON deposit_disputes(deposit_id) WHERE status = 'open';
CREATE UNIQUE INDEX deposit_disputes_one_lost ON deposit_disputes(deposit_id) WHERE status = 'lost';
CREATE INDEX deposit_disputes_user ON deposit_disputes(user_id, status);
CREATE FUNCTION deposit_dispute_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id,NEW.deposit_id,NEW.user_id,NEW.provider,NEW.amount_minor,NEW.reason,NEW.opened_by,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.deposit_id,OLD.user_id,OLD.provider,OLD.amount_minor,OLD.reason,OLD.opened_by,OLD.created_at)
     OR OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Dispute is immutable once resolved' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deposit_dispute_guard BEFORE UPDATE OR DELETE ON deposit_disputes
  FOR EACH ROW EXECUTE FUNCTION deposit_dispute_guard();

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  period_end timestamptz NOT NULL,
  reported_held_minor bigint NOT NULL,
  internal_held_minor bigint NOT NULL,
  difference_minor bigint NOT NULL,
  checks jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','mismatch')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER reconciliation_runs_immutable BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
