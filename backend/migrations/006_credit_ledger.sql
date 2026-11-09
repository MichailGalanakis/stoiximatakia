-- Single-currency, integer-hundredth ledger. Existing balances are imported once;
-- all future accounts receive the owner-approved 250-credit opening grant.
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE credit_accounts (
  key text PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('available','reserved','issuance','fees','pool')),
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CHECK ((kind IN ('available','reserved')) = (user_id IS NOT NULL)),
  CHECK (kind = 'issuance' OR balance_minor >= 0),
  UNIQUE(user_id, kind)
);
CREATE TABLE credit_journals (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('opening','grant','reserve','release','start','settle')),
  reference_id text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_postings (
  journal_id uuid NOT NULL REFERENCES credit_journals(id),
  account_key text NOT NULL REFERENCES credit_accounts(key),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY(journal_id, account_key)
);
CREATE INDEX credit_postings_account ON credit_postings(account_key);
CREATE FUNCTION credit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Credit history is append only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER credit_journal_immutable BEFORE UPDATE OR DELETE ON credit_journals
  FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER credit_posting_immutable BEFORE UPDATE OR DELETE ON credit_postings
  FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE FUNCTION credit_apply_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE credit_accounts SET balance_minor=balance_minor+NEW.amount_minor WHERE key=NEW.account_key;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_posting_apply AFTER INSERT ON credit_postings
  FOR EACH ROW EXECUTE FUNCTION credit_apply_posting();
CREATE FUNCTION credit_check_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal uuid;
BEGIN
  IF TG_TABLE_NAME='credit_journals' THEN journal:=NEW.id; ELSE journal:=NEW.journal_id; END IF;
  IF (SELECT count(*) < 2 OR sum(amount_minor) <> 0 FROM credit_postings WHERE journal_id=journal) THEN
    RAISE EXCEPTION 'Unbalanced credit journal' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER credit_journal_balanced AFTER INSERT ON credit_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_check_journal();
CREATE CONSTRAINT TRIGGER credit_postings_balanced AFTER INSERT ON credit_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_check_journal();
CREATE FUNCTION credit_check_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT balance_minor FROM credit_accounts WHERE key=NEW.key) <>
     (SELECT coalesce(sum(amount_minor),0) FROM credit_postings WHERE account_key=NEW.key) THEN
    RAISE EXCEPTION 'Credit projection does not reconcile' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER credit_account_reconciled AFTER INSERT OR UPDATE ON credit_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_check_account();
INSERT INTO credit_accounts(key,kind) VALUES ('issuance','issuance'),('fees','fees');
INSERT INTO credit_accounts(key,user_id,kind)
  SELECT 'available:'||id,id,'available' FROM users
  UNION ALL SELECT 'reserved:'||id,id,'reserved' FROM users;
INSERT INTO credit_journals(id,operation_key,kind,reference_id)
  SELECT id,'opening:'||id,'opening',id::text FROM users WHERE demo_credits_minor>0;
INSERT INTO credit_postings(journal_id,account_key,amount_minor)
  SELECT id,'available:'||id,demo_credits_minor FROM users WHERE demo_credits_minor>0
  UNION ALL SELECT id,'issuance',-demo_credits_minor FROM users WHERE demo_credits_minor>0;
CREATE FUNCTION credit_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO credit_accounts(key,user_id,kind) VALUES
    ('available:'||NEW.id,NEW.id,'available'),('reserved:'||NEW.id,NEW.id,'reserved');
  INSERT INTO credit_journals(id,operation_key,kind,reference_id)
    VALUES (NEW.id,'grant:'||NEW.id,'grant',NEW.id::text);
  INSERT INTO credit_postings(journal_id,account_key,amount_minor) VALUES
    (NEW.id,'available:'||NEW.id,25000),(NEW.id,'issuance',-25000);
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_user_created AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION credit_new_user();
-- Retain the legacy column only as a frozen import source, never spend authority.
CREATE FUNCTION credit_freeze_legacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.demo_credits_minor IS DISTINCT FROM OLD.demo_credits_minor THEN
    RAISE EXCEPTION 'Legacy balance is frozen' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_legacy_frozen BEFORE UPDATE OF demo_credits_minor ON users
  FOR EACH ROW EXECUTE FUNCTION credit_freeze_legacy();
