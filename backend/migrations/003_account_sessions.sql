ALTER TABLE users ADD COLUMN account_kind text NOT NULL DEFAULT 'registered'
  CHECK (account_kind IN ('registered', 'demo'));
ALTER TABLE users ADD COLUMN demo_credits_minor integer NOT NULL DEFAULT 0
  CHECK (demo_credits_minor >= 0);

-- Demo contacts are unique internal placeholders, never deliverable destinations.
ALTER TABLE users DROP CONSTRAINT users_phone_check;
ALTER TABLE users ALTER COLUMN terms_version DROP NOT NULL;
ALTER TABLE users ALTER COLUMN terms_accepted_at DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_account_contacts_check CHECK (
  (account_kind = 'registered' AND phone ~ '^\+[1-9][0-9]{6,14}$'
    AND email NOT LIKE '%@demo.invalid'
    AND terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL)
  OR
  (account_kind = 'demo' AND phone = 'demo:' || id::text
    AND email = id::text || '@demo.invalid'
    AND NOT email_verified AND NOT phone_verified
    AND terms_version IS NULL AND terms_accepted_at IS NULL)
);

-- Independent of the older, restricted registration token. Only digests persist.
CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_sessions_expiry ON account_sessions(expires_at);
