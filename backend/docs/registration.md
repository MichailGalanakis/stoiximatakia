# Pending-account registration

Owner-approved temporary override, 2 November 2026: every new registered account stores `email_verified=true` during signup while Resend domain verification is pending. Registration, account/session and profile responses therefore report email as verified, and code initialization skips email delivery. Phone verification is unchanged. Existing accounts are not backfilled; Demo placeholders remain unverified and non-deliverable. No migration or environment change is needed. This override has no automatic expiry; remove it explicitly when real email verification is restored. The flag under this override does not prove inbox ownership.

Implemented on 31 October 2026. Signup creates durable users and restricted registration sessions. Step 2 now sends and verifies email/SMS codes using Resend and seven.io, with per-channel backend cooldowns. Automatic sign-in after creation is implemented; password sign-in is also implemented, while recovery, identity checks, and game/wallet authorization remain separate. See [account sessions](account-sessions.md) for the current sign-in and one-click Demo contract. See [contact verification](contact-verification.md) for the current delivery contract.

Owner-confirmed target, 1 November 2026: generated and registered accounts have the same table/credit capabilities and use [one credit currency](credits.md). Their creation paths and contact-delivery protections remain distinct. The [table plan](multiplayer-tables.md) does not add contact/identity verification as a table eligibility gate, and it does not change this registration API or turn its restricted cookie into an account session. The [shared table/ledger backend](platform-api.md) is now implemented; game actions, frontend table wiring and settlement remain pending. New account creation atomically grants 250 credits through migration 006's ledger trigger.

## API

`POST /auth/registrations` accepts JSON:

```json
{
  "username": "PlayerOne",
  "password": "an example passphrase",
  "email": "player@example.com",
  "phone": "6912345678",
  "termsAccepted": true,
  "termsVersion": "2026-10-20-a4"
}
```

The browser must send `Origin` equal to `APP_ORIGIN` and `X-SkillBetting-Client: web-v1`. There is no CORS grant. The existing frontend proxy strips `/api`. Unknown fields are rejected, including caller-supplied IDs, roles, balances, verification flags, and timestamps.

Username: trim, NFC normalization, 3–30 letters/numbers/underscore/dot/hyphen; preserve display case and compare lowercase keys. Email: trim/lowercase, validated, maximum 120. Phone: validate the entire string with libphonenumber, default country GR, reject extensions, store E.164; maximum input length 30. Password: 10–72 characters using the original form limits, no trimming or truncation. Database uniqueness covers normalized username, email, and phone. A race creates at most one user with the same identifiers.

Registration envelope (returned by GET and POST; POST additionally returns `account` and sets an independent account-session cookie as documented in [account sessions](account-sessions.md)):

```json
{
  "registration": {
    "id": "<server UUID>",
    "username": "PlayerOne",
    "email": "player@example.com",
    "phone": "+306912345678",
    "status": "verification_required",
    "emailVerified": true,
    "phoneVerified": false,
    "delivery": { "email": "verified", "phone": "ready" },
    "verification": {
      "email": {
        "state": "verified",
        "available": true,
        "retryAfterSeconds": 0,
        "expiresAt": null
      },
      "phone": {
        "state": "ready",
        "available": true,
        "retryAfterSeconds": 0,
        "expiresAt": null
      }
    }
  },
  "termsVersion": "2026-10-20-a4"
}
```

GET returns `registration: null` for missing, malformed, unknown, or expired cookies. No lookup by user-supplied ID/email is exposed. Both endpoints use `Cache-Control: no-store`.

The frontend pins the version of its displayed terms page and refuses signup if GET reports a newer version. POST independently checks the current backend version. Update the document and both versions together; the captured terms content has not been rewritten or approved as a new production policy by this increment.

Errors retain `{statusCode,error,message,requestId}` and known registration errors add `code`: `invalid_registration` (400), `terms_changed` (409), `registration_conflict` (409; no identifier-specific disclosure), `registration_limited` (429), `origin_rejected` (403), `registration_unavailable` (503). Contact-verification writes add the codes documented in the verification contract. DTO failures are generic 400 responses. The client translates codes into Greek; arbitrary server/proxy error text is never rendered. A timeout/network failure is ambiguous about whether the transaction committed; the UI does not claim that no user exists. Reopening resumes if the cookie arrived. Recovery when the response/cookie was lost, or after session expiry, requires the future login/recovery flow; duplicate signup does not overwrite an account.

## Storage and security decisions

`src/registration` owns the controller, DTO, service, password helpers, and PostgreSQL store. No generic repository layer or ORM is needed for this small transaction. `pg` uses parameterized SQL; user plus registration and account session inserts commit together on one connection. Terms version and server timestamp are stored with the user. Failures roll back both inserts; no ephemeral business store is exposed.

Passwords use native asynchronous scrypt with a random 16-byte salt, N=131072, r=8, p=1, and a 64-byte key. The encoded hash records its parameters. At most two password hashes run per process; excess work returns unavailable rather than queuing unbounded memory. See [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) and [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

A random 32-byte opaque token is sent only in an HttpOnly, SameSite=Lax, Path=/ cookie for 24 hours. Only its SHA-256 digest is persisted. HTTPS origins use `__Host-sb_registration` with Secure; local HTTP uses `sb_registration`. `NODE_ENV=production` requires an HTTPS `APP_ORIGIN`. The token directly grants only registration reads and contact-code operations. The new origin-protected `POST /auth/session` can explicitly exchange a valid registration credential for an independent account session. No Match or wallet write accepts either credential in this increment. It is never written to localStorage/sessionStorage or returned in JSON.

Signup attempts are limited to ten per database hour bucket per hashed connection IP, shared across processes. DTO/normalization failures do not reach password hashing. Fastify currently does not trust forwarded headers: through Next/reverse proxies callers share the proxy IP bucket. Establish explicit trusted proxy hops and edge abuse controls before public deployment; do not enable arbitrary forwarded-header trust. Expired registration sessions need a future maintenance policy; GET already rejects them.

Existing allowlisted logs remain unchanged: no bodies, raw exceptions, passwords, cookies, contact details, or tokens are logged. `/health` remains liveness only and can succeed while PostgreSQL is unavailable. A missing DB configuration leaves health usable but signup returns 503.

## Migrations and local use

`npm run db:local:start` initializes an ignored project-local `.local/postgres` cluster, private owner-only socket directory, and separate `skillbetting` / `skillbetting_test` databases. It uses local trust only behind that private directory and disables TCP listening; it is a development helper, not Linux deployment configuration. `npm run db:local:stop` stops only that cluster. Keep `.local/` out of Git and formatters.

`npm run db:migrate` applies sorted SQL files transactionally under a PostgreSQL advisory lock and records each filename/checksum. Repeated execution is a no-op; changed applied migrations fail. Add migrations instead of editing applied files. Startup does not migrate automatically. On Linux provide `DATABASE_URL` and `APP_ORIGIN` through server configuration; use a restricted DB role and appropriate transport/storage controls during deployment.

## Verification

`npm run check` runs type/lint/format checks, unit and HTTP regression tests, and a build. `npm run test:integration` additionally requires `TEST_DATABASE_URL` pointing to a dedicated database whose name ends in `_test`; the local helper supplies it. The integration suite creates a unique schema and drops only that schema afterward.

PostgreSQL HTTP tests cover durable restart/resume, normalized values, salted passwords, stored terms, secure cookies, expiry/forgery, untrusted origins, forged privilege fields, duplicate races, transaction rollback when session insertion fails, shared attempt limits, outage behavior, and secret-safe logs. Frontend component/API tests and real-browser checks are recorded in the frontend handoff. No real email/SMS is sent by these tests. Runtime dependency audit: zero findings; the existing development lint dependency chain reports moderate minimatch advisories and has not been force-downgraded as part of signup.

## Delivery setup handoff

Read-only prefilled destinations are now explicit fields on the frontend. They use the server-returned saved email and normalized phone, including on resume. Provider delivery and code checking are now implemented; backend credentials are loaded only on restart. The [provider setup notes](verification-provider-setup.md) link the official Resend/seven.io APIs and document backend-only local key names. The backend consumes those settings. Initial sends occur on entering step 2, with no extra sends on refresh.

## Closed registration flow

Registration is now a one-time onboarding flow. Closing it after account creation records server-side dismissal; login also ends onboarding. The credits/header action opens the large wallet and never resumes these panels. `GET /auth/registration` returns null for dismissed users, and registration-bound code operations are unavailable after dismissal. See [profile and navigation](profile.md). Earlier references to reopening registration apply only to an undismissed initial flow.
