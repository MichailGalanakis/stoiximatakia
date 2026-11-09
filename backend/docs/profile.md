# Current-user profile and account navigation

Implemented 31 October 2026. The frontend credits control opens the **large static Demo wallet** (`payment-center`), for both registered and temporary accounts. It does not reopen registration or the compact onboarding identity panel. Profile identity and metadata come from the active account session.

Owner direction, 1 November 2026: the planned backend uses [one credit currency](credits.md) for both account creation paths and the [shared funded table flow](multiplayer-tables.md). Demo wallet labels remain permitted. The historical counter limitations below predate migrations 006/007. The [platform API](platform-api.md) now supplies ledger-available credits through the existing `demoCreditsMinor` field, with existing balances preserved and 250 credits for every new account. Wallet ticket/game/payment controls remain unconnected. Every frontend change, including copy, balance binding or enabling an existing control, requires prior discussion and explicit agreement. This documentation update changes neither the wallet nor its API.

## Profile API

`GET /auth/profile` requires the account cookie and returns:

```json
{
  "account": {
    "id": "<UUID>",
    "username": "Player",
    "kind": "registered",
    "email": "player@example.com",
    "phone": "+306912345678",
    "emailVerified": true,
    "phoneVerified": false,
    "demoCreditsMinor": 0
  },
  "details": { "fullName": "", "country": "", "city": "" },
  "participationTerms": {
    "version": "2026-10-20-a4",
    "acceptedAt": "<ISO timestamp>"
  }
}
```

Demo terms metadata is null; acceptance is never invented. Migration `004_profile_details.sql` adds optional, initially empty metadata fields. `POST /auth/profile` accepts only `{fullName,country,city}`, each a string with maximum lengths 80/60/80. Values are trimmed and NFC-normalized. Username, email, phone, account ID, verified flags, credits, and terms metadata cannot be changed through this endpoint. Those three account identifiers remain read-only in the UI. Both account kinds can save personal metadata; this neither establishes identity/KYC nor converts a Demo account into a registered account.

Both operations select the user from a valid account-token digest and check expiry in SQL. The update performs its authorization and write in one statement; it never accepts a target user ID. Missing, forged, or expired credentials return `401 account_session_expired`. Writes additionally require the exact configured Origin and client header. All responses use no-store caching. Logs contain no submitted personal details. A registration-only token is not a profile credential.

## Sign-in and one-time registration steps

`POST /auth/login` accepts only `{username,password}`. Username is trimmed/NFC-normalized/lowercased; the existing scrypt hash checks the exact password. Unknown usernames and wrong passwords return the same `401 invalid_credentials`; unknown accounts still incur password-hashing work. Temporary accounts cannot use password login. Ten attempts per hour are enforced for both hashed connection IP and hashed username; hashing shares the existing two-operation concurrency bound. No passwords, cookies, or exception bodies are logged.

On success, a fresh 30-day account cookie is issued and the presented old account token is revoked in the same transaction. The registration cookie is cleared. No verification codes are sent and the registration panels are not reopened. Password reset, social login, and session-management UI remain future work. The existing proxy-IP limitation still applies before deployment.

Migration `005_registration_dismissal.sql` adds `registration_dismissed_at`. Closing an already-created registration popup requests protected `POST /auth/registration/dismiss` with `{}`. The timestamp is recorded once on the user, not just in browser state, so it survives logout/login/restarts. The frontend uses a keepalive request for this close operation. It clears the registration cookie; GET/resume no longer exposes that dismissed registration. Login also marks the registration flow dismissed, so an existing account signing in never reenters onboarding. Contact and identity flags are not automatically verified by dismissal or login.

Registration code operations still use their pending-registration boundary and are unavailable after dismissal. The large wallet shows saved contact statuses but the static design has no OTP-entry card there. Any future way to resume verification should be a separately designed account feature, not reopening the one-time registration popup from the credits control. Sumsub remains unconnected.

## Frontend scope and validation

The user explicitly selected the large static Demo wallet, not the compact normal profile. Its original 12 sections, drawer, selectors, icons, payment previews, illustrative flows, and text are retained. React owns all nodes; no legacy JavaScript runs in the app. Actual account identity, contact flags, terms, available credits and editable metadata replace fixture values; the ledger now owns the available balance behind the compatibility field. Saving details and logout are connected. Payments, credit refill, provider identity actions, live game/history data, limits, and support writes remain unconnected; illustrative payment/tournament/game examples do not execute transactions.

The homepage is now an application shell with header/dialogs and an empty `main` awaiting the separately requested lobby migration. COMPONENT PREVIEW controls are removed; no lobby work is authorized by this task. Existing preview/reference URLs remain development tooling.

39 frontend tests, 32 backend regression tests, and 26 PostgreSQL integration tests pass (97 total), including cross-account isolation, stored values after restart, locked identifiers, expiry/origin/DTO failures, password login/rate limits, persistent dismissal, the large wallet route, sign-in separation, mobile drawer logic, and local-only illustrative flows. Integration uses isolated test schemas/fake delivery. Browser use remains disabled: desktop/mobile visual parity and native browser focus/scroll are unverified. An isolated production frontend build passes; see frontend handoff for the scoped design target.
