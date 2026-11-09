CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL CHECK (length(username) BETWEEN 3 AND 30),
  username_key text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email text NOT NULL UNIQUE CHECK (length(email) <= 120),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  status text NOT NULL DEFAULT 'verification_required' CHECK (status = 'verification_required'),
  email_verified boolean NOT NULL DEFAULT false CHECK (NOT email_verified),
  phone_verified boolean NOT NULL DEFAULT false CHECK (NOT phone_verified),
  terms_version text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- This token authorizes only resuming registration, never games or wallet actions.
CREATE TABLE registration_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX registration_sessions_expiry ON registration_sessions(expires_at);

CREATE TABLE registration_limits (
  key text NOT NULL,
  bucket timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 10),
  PRIMARY KEY (key, bucket)
);
