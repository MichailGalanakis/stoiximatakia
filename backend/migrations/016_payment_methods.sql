-- Payment methods per country, jurisdiction approval, RF bank collections,
-- transactional notifications and unattended reconciliation runs.

-- A method can only be active where the activity is approved.
CREATE TABLE jurisdictions (
  country char(2) PRIMARY KEY CHECK (country ~ '^[A-Z]{2}$'),
  approved boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Authoritative country of a player (KYC or finance); otherwise the phone country.
CREATE TABLE player_jurisdictions (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  source text NOT NULL CHECK (source IN ('admin','kyc')),
  set_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_methods (
  method text NOT NULL CHECK (method ~ '^[a-z0-9_]{2,40}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,40}$'),
  country char(2) NOT NULL REFERENCES jurisdictions(country),
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  direction text NOT NULL CHECK (direction IN ('deposit','withdrawal')),
  active boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(method, provider, country, currency, direction)
);
CREATE FUNCTION payment_method_approved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active AND NOT (SELECT approved FROM jurisdictions WHERE country = NEW.country) THEN
    RAISE EXCEPTION 'Payment method requires an approved jurisdiction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_method_approved BEFORE INSERT OR UPDATE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION payment_method_approved();
CREATE FUNCTION jurisdiction_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved AND NOT NEW.approved THEN
    UPDATE payment_methods SET active = false, updated_by = NEW.updated_by, updated_at = now()
      WHERE country = NEW.country AND active;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER jurisdiction_withdrawn AFTER UPDATE ON jurisdictions
  FOR EACH ROW EXECUTE FUNCTION jurisdiction_withdrawn();

-- Sandbox defaults for development. Real approval is a legal decision: review
-- these rows before any real-money provider is enabled.
INSERT INTO jurisdictions(country, approved, note, updated_by)
  VALUES ('GR', true, 'Sandbox default; confirm the legal basis before real money', 'migration-016');
INSERT INTO payment_methods(method, provider, country, direction, active, updated_by) VALUES
  ('card', 'sandbox', 'GR', 'deposit', true, 'migration-016'),
  ('card', 'sandbox', 'GR', 'withdrawal', true, 'migration-016'),
  ('rf_bank', 'bank_rf', 'GR', 'deposit', true, 'migration-016'),
  ('bank_transfer', 'bank_rf', 'GR', 'withdrawal', true, 'migration-016');

ALTER TABLE deposits ADD COLUMN method text NOT NULL DEFAULT 'card';
ALTER TABLE withdrawal_requests ADD COLUMN method text NOT NULL DEFAULT 'card';
INSERT INTO wallet_accounts(key, kind) VALUES ('external:bank_rf', 'external');

-- Imported bank statement lines for RF collections, matched to deposits.
CREATE TABLE bank_receipts (
  bank_reference text PRIMARY KEY CHECK (length(bank_reference) BETWEEN 1 AND 100),
  rf_code text NOT NULL CHECK (rf_code ~ '^RF[0-9]{2}[A-Z0-9]{1,21}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  paid_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('matched','unmatched')),
  reason text,
  deposit_id uuid REFERENCES deposits(id),
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'matched') = (deposit_id IS NOT NULL))
);
CREATE TRIGGER bank_receipts_immutable BEFORE UPDATE OR DELETE ON bank_receipts
  FOR EACH ROW EXECUTE FUNCTION wallet_append_only();

-- Written in the same transaction as the event, delivered afterwards.
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('tournament_ticket')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (length(last_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_outbox_pending ON notification_outbox(created_at) WHERE status = 'pending';

-- Unattended runs may have no provider statement yet.
ALTER TABLE reconciliation_runs ALTER COLUMN reported_held_minor DROP NOT NULL;
ALTER TABLE reconciliation_runs ALTER COLUMN difference_minor DROP NOT NULL;
ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_runs_statement
  CHECK ((reported_held_minor IS NULL) = (difference_minor IS NULL));
