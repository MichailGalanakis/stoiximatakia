# API and use-case catalog

## Current deployment boundary — 2 November 2026

The owner-approved release contains Xeri, Diloti, Koum Kan, Thanasis, Biriba, Tichu and human-only chess PvP. Chess uses the strict proof-artifact profile; computer play remains disabled. Production rejects funding for any unregistered engine without changing credits. Health/registration/Platform are the public runtime; the old Match prototype remains unregistered. `/health/ready` requires migration 009. Production retains stable configuration and the single controlled edge hop. The [container runbook](../deploy/README.md) and [server-agent handoff](../deploy/SERVER-AGENT.md) cover deployment, backups and recovery. Public deployment is separate from the passing local checks; see the [current checkpoint](backend-progress.md). External payments, computer/chat workflows and paid-result corrections remain inactive.

All seven games have registered adapters and authenticated participant-only HTTP/native websocket actions. The six card games retain round results/Next; Diloti/Koum Kan provide exact read-only selection feedback. Chess is a single standard game with fixed seat colours, legal moves/promotion, draw commands and authoritative results. See [chess actions](platform-api.md#chess-participant-actions--approved-2-november-2026) and [card actions](platform-api.md#card-gameplay-integration--1-november-2026).

This catalog connects backend behavior to features. It documents the current code; ideas do not become endpoints until their contracts are agreed and implemented. See the [system map](system-map.md) for the overall picture.

The [multiplayer table decisions and plan](multiplayer-tables.md), [one-currency credit model](credits.md), and [implemented platform API](platform-api.md) describe the shared backend foundation. Migration 006 imports existing credits once and grants every new account 250 credits; account responses retain `demoCreditsMinor` as ledger-available balance. Migration 007 adds funded tables/tickets and the backend exposes authenticated HTTP commands plus native websocket updates. Migration 008 adds permanent match roster/action history and atomic initial win/draw/cancel/void settlement. Xeri/Diloti/Koum Kan engine integration and all three approved frontend activations are now implemented. Their owner-confirmed move/forfeit/disconnect and draw/cancel/void financial policies are recorded in [credits](credits.md). The shared lifecycle now exposes authenticated cancellation/forfeit and participant-only match summaries; authenticated gameplay is exposed for registered adapters; no client result-reporting or public void writer is exposed. Every frontend change still requires prior discussion and explicit agreement.

## Feature inventory

| User/system goal                                                              | Use case                        | State                                                 | Public endpoint                      |
| ----------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| Check that the backend is responding.                                         | Check process liveness.         | Implemented.                                          | `GET /health`                        |
| Record a Match's initial reported winner while preserving provenance.         | Record initial Match result.    | Internal prototype, exercised in tests.               | None.                                |
| Create/join funded tables, manage tickets and readiness, inspect own credits. | Shared table/credit operations. | Backend and Xeri/Diloti/Koum Kan frontends connected. | See [platform API](platform-api.md). |
| Receive live table/lobby snapshots and send the same protected commands.      | Native websocket transport.     | Backend and registered engine actions implemented.    | `/multiplayer/v1/live`               |

Shared lifecycle routes: `GET /multiplayer/v1/tables/:tableId/match` and `POST /multiplayer/v1/tables/:tableId/forfeit` (`operationId`, `expectedRevision`). The cancellation route now also handles started zero-gameplay whole-match refunds. Controlled adapters validate shared lifecycle/settlement, and real Xeri/Diloti adapters validate game integration. Full contracts and internal technical-void authority are in [platform API](platform-api.md).

PostgreSQL persists users, account/registration sessions, contact challenges, the single-credit ledger and funded tables/tickets. The running application exposes health, the registration endpoints below and the [platform routes](platform-api.md). Test-only routes are excluded from the public contract.

## Registration endpoints

- `POST /auth/registrations`: create a durable user with email verified and phone unverified under the owner-approved temporary Resend setup override, save terms acceptance, and issue independent registration and signed-in account cookies. Returns `201` with the pending registration and account. See [registration](registration.md) for override scope and removal.
- `GET /auth/registration`: resume the pending registration from the cookie, or return `registration: null`. Returns the current terms version too.

The frontend uses `/api/auth/registrations` and `/api/auth/registration` through its existing rewrite. The [registration contract](registration.md) records requests, responses, errors, sessions, and test commands. Signup establishes the current signed-in account and the same funded-table capability as generated accounts; game actions and wallet payment/withdrawal controls remain separate. Delivery/OTP verification is implemented by the [contact-verification endpoints](contact-verification.md), including an idempotent initial send, manual resend, and code checking.

The current response also exposes per-channel `verification` metadata (`state`, `available`, `retryAfterSeconds`, `expiresAt`). First-entry initialization and manual resends are distinct operations; GET has no delivery side effects.

## GET /health

**Purpose:** Confirm that the application can handle an HTTP request. This does not check PostgreSQL connectivity, dependency readiness, or Match functionality.

**Caller:** Any caller that can reach the application; no authentication is required.

**Request:** No path parameters, required query parameters, or request body.

```sh
curl -i http://127.0.0.1:3000/health
```

**Successful response: `200 OK`**

```http
Content-Type: application/json; charset=utf-8
x-request-id: <server-generated UUID>
```

```json
{
  "status": "ok"
}
```

**Side effects:** No business state changes. The application writes request completion metadata to its logs.

Implementation: [`HealthController`](../src/health/health.controller.ts). HTTP behavior: [`http.e2e-spec.ts`](../test/http.e2e-spec.ts).

## Shared HTTP behavior

The server generates a request ID and returns it in `x-request-id`. Errors use this envelope, illustrated with a request to an unknown route:

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Not Found",
  "requestId": "<server-generated UUID>"
}
```

Messages currently use standard HTTP status text. Raw exception details and request values are not included. The body size limit is 1 MiB. A global validation pipe is configured for decorated request DTOs; `/health` has no input DTO.

## Internal use case: record initial Match result

**State:** Implemented as `RecordMatchResultService`; not exposed by the running application. The HTTP tests use a fixture controller and an in-memory repository to demonstrate the complete flow.

**Caller:** Must eventually be a trusted, authorized caller. The actual identity and authorization mechanism is undecided; the service itself does not authenticate a caller.

**Input:**

| Field         | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `matchId`     | Existing Match to load.                                     |
| `operationId` | Stable identifier reused when retrying the same operation.  |
| `winnerId`    | One of the Match's two participant IDs.                     |
| `actorId`     | Recording actor established by the trusted caller boundary. |

These are application inputs, not an agreed HTTP request body. In particular, a client-supplied actor ID does not prove identity or permission.

**Behavior:** Load the Match, invoke its `recordResult()` method, and save a new transition with the expected version. Return a snapshot containing the Match ID, participants, version, and original result/provenance. The service supplies the recording timestamp.

- An exact retry returns the original record without saving again.
- A conflicting reuse of the operation ID or another attempt to replace the original result fails.
- A missing Match, invalid result, stale save, or persistence failure is surfaced as an application/domain error. Production HTTP mappings have not been defined.
- Recording a result does not verify game evidence or authorize settlement.

Implementation: [`RecordMatchResultService`](../src/matches/application/record-match-result.service.ts), [`Match`](../src/matches/domain/match.ts), and [`MatchRepository`](../src/matches/application/match.repository.ts).

## Format for future feature discussions

Describe a feature with these questions before choosing its URL:

1. **Goal:** What does the user or system want to accomplish?
2. **Caller:** Who requests it, and what permission is required?
3. **Input and result:** What information is supplied, and what should come back?
4. **Rules and effects:** What may change, and what must be rejected?
5. **Status:** Is this an idea, an agreed contract, or implemented behavior?

Once agreed, add the HTTP method/path, request and response examples, errors, and implementation/test references. Some internal use cases may never need a public endpoint.

## Account sessions and Demo — 31 October 2026

[Account sessions](account-sessions.md) defines the implemented automatic signup sign-in, independent account cookie, read-only `GET /auth/session`, protected registration-session upgrade `POST /auth/session`, one-click `POST /auth/demo`, and `POST /auth/logout`. Signup now also returns `account`. Both registered and temporary accounts use durable PostgreSQL sessions; identity/game/wallet/payment authority is not granted by signing in. Existing code-verification endpoints can identify the current registered account through its account cookie. Demo accounts cannot send verification messages. Password sign-in and account recovery remain pending.

## Current-user profile, login, and dismissal

[Profile and account navigation](profile.md) documents implemented `GET /auth/profile`, `POST /auth/profile`, `POST /auth/login`, and `POST /auth/registration/dismiss`. All profile reads/writes are bound to the session owner. Credits/header navigation opens the large wallet; registration dismissal survives logout/login and no existing account reenters onboarding on login. Profile metadata does not change contacts, verification flags, or financial authority.
