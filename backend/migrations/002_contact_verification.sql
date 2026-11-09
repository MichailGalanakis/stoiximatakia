ALTER TABLE users DROP CONSTRAINT users_email_verified_check;
ALTER TABLE users DROP CONSTRAINT users_phone_verified_check;

CREATE TABLE verification_challenges (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'phone')),
  request_id uuid NOT NULL,
  code_digest text,
  expires_at timestamptz NOT NULL,
  resend_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  send_state text NOT NULL CHECK (send_state IN ('sending', 'sent', 'failed', 'verified')),
  send_window timestamptz NOT NULL,
  send_count integer NOT NULL CHECK (send_count BETWEEN 1 AND 10),
  PRIMARY KEY (user_id, channel)
);
