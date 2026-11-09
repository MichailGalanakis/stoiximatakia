# Email and phone code verification

Temporary owner-approved signup override, 2 November 2026: new registered accounts persist email as verified without sending/checking an email code while Resend domain setup is pending. Initialization skips that verified channel and sends only SMS; phone verification still requires its code. Existing account flags and Demo placeholder protections are unchanged. This does not establish inbox ownership and does not automatically expire. Remove the signup override explicitly when restoring real email verification; see [registration](registration.md).

Implemented 31 October 2026. Step 2 automatically requests initial codes for unverified channels through Resend/seven.io when the registration is opened. The first-entry operation is idempotent: reopening, reloading, or racing another tab does not send again. The initial request happens after the registration cookie is issued; the database user is not rolled back if either provider fails.

## HTTP contract

All writes require the existing registration cookie, exact `APP_ORIGIN`, and `X-SkillBetting-Client: web-v1`. Destinations always come from the saved user; callers cannot select another user or recipient.

- `POST /auth/registration/codes` initializes channels that have never had a challenge. It returns each channel's status, including partial delivery failure. It does not resend an existing failed/expired challenge.
- `POST /auth/registration/codes/email/send` and `/phone/send` request an explicit resend after its cooldown. The previous challenge is replaced.
- `POST /auth/registration/codes/email/verify` and `/phone/verify` accept `{ "code": "123456" }`. The backend changes only the matching channel's flag after a valid check.
- `GET /auth/registration` remains read-only and returns current verification/cooldown metadata. It does not send messages.

Successful writes return the existing `{ registration, termsVersion }` envelope. `registration.emailVerified` and `phoneVerified` are now booleans. `delivery` has a per-channel state: `unavailable`, `ready`, `sending`, `sent`, `failed`, or `verified`. `verification.email` / `.phone` contain that `state`, provider `available`, `retryAfterSeconds`, and `expiresAt` (ISO string or null). No code, digest, secret, or provider response body is returned.

Each channel has its own **60-second cooldown**, starting when the database reserves a send attempt. The backend also caps each user/channel at ten send attempts per one-hour send window. Failure still consumes the attempt/cooldown, preventing rapid provider retry loops. A too-early resend returns `429`, `code: verification_cooldown`, `Retry-After`, and `retryAfterSeconds`. Reloading uses the remaining database time, not a new browser minute. Expiry of the timer only enables the existing button: it never triggers another automatic send.

Other known errors: `registration_session_expired` (401), `verification_invalid_code` (400), and `verification_unavailable` (503). The frontend refreshes status after a failed write so it can restore the server cooldown. An individual failed initial provider send appears as `delivery: failed`; it does not undo the account or the other channel's success.

## One-time challenges and concurrency

Migration `002_contact_verification.sql` removes the initial false-only flag constraints and adds one durable challenge row per user/channel. New codes are six cryptographically random digits, valid for ten minutes, with at most five valid-format guesses per challenge. A resend invalidates the previous challenge. Successful verification consumes the digest and stores the matching user's flag in the same transaction. Attempts commit even when the code is invalid.

Only an HMAC-SHA256 digest of user ID, channel, challenge UUID, and code is stored. `OTP_SECRET` is a high-entropy server key, stable across restarts and kept outside Git. Plain codes live only in memory and the provider request. Provider responses, errors, request bodies, keys, and codes are never logged.

Send reservation locks the user/challenge transactionally and commits the cooldown before calling a provider. External HTTP does not hold database locks. Concurrent tab/process requests share the same limit. A completion is conditional on its challenge UUID, so a slow old send cannot overwrite a newer challenge. There is no automatic HTTP retry or background delivery worker. A crash/timeout can leave an uncertain send; the manual resend becomes eligible after the stored delay, creates a new challenge, and may invalidate a code that arrived late. Exactly-once SMS delivery is not claimed.

Resend uses a challenge-specific idempotency key; seven's `foreign_id` is a correlation ID, not an exactly-once guarantee. A `sent` state means provider acceptance, not a delivery receipt or verified ownership. A failed/uncertain provider call is not marked verified. Sandbox/debug SMS successes are rejected by the live adapter.

Contact verification does not authorize games/wallets or implement identity/KYC. Signup now independently creates an account session before contact verification; see [account sessions](account-sessions.md). The frontend now enables the next-identity button once both saved contact flags are true and opens the captured profile identity tab. This is presentation only: the restricted registration session is unchanged, and Sumsub start/status actions remain disabled until the identity contract and provider integration exist.

## Configuration and tests

Backend-only `.env`: `RESEND_API_KEY`, `RESEND_FROM`, `SEVEN_API_KEY`, `SEVEN_SENDER`, and `OTP_SECRET`. Sender defaults are `SkillBetting <onboarding@resend.dev>` and `SkillBet`. Generate a local secret without displaying it using `npm run verification:secret`; existing valid values are preserved. Apply `npm run db:migrate` and restart the backend to load configuration. Missing provider keys leave that channel unavailable. Resend's development sender only permits the account-owner inbox; use a verified domain for other recipients. See [provider setup](verification-provider-setup.md) for official links.

Tests use fake providers, never live keys/recipients. PostgreSQL tests cover concurrent first entry, restart/resume, independent cooldowns, racing resends, invalidation, expiry, five-attempt lockout, consumption, partial provider failure, hourly caps, origin/session/DTO checks, and secret-safe logs. Frontend tests exercise automatic initialization, elapsed countdown without periodic sending, resend, server time on reopen, verified flags, and failed delivery. Provider adapter tests check request formats and seven's body-level result. Run `npm run check` and `npm run test:integration` in the backend, and `npm test` in the frontend.

Closing the registration flow now records persistent dismissal. The credits control opens the large static Demo wallet, which displays saved contact flags and does not reopen OTP onboarding. A separate account-verification entry point awaits designer direction. See [profile and navigation](profile.md).
