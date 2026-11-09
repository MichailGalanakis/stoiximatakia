# Initial architecture and decisions

## Current deployment boundary — 2 November 2026

The owner-approved release contains Xeri, Diloti, Koum Kan, Thanasis, Biriba, Tichu and human-only chess PvP. Chess uses the strict proof-artifact profile; computer play remains disabled. Production rejects funding for any unregistered engine without changing credits. Health/registration/Platform are the public runtime; the old Match prototype remains unregistered. `/health/ready` requires migration 009. Production retains stable configuration and the single controlled edge hop. The [container runbook](../deploy/README.md) and [server-agent handoff](../deploy/SERVER-AGENT.md) cover deployment, backups and recovery. Public deployment is separate from the passing local checks; see the [current checkpoint](backend-progress.md). External payments, computer/chat workflows and paid-result corrections remain inactive.

All seven games have registered adapters and authenticated participant-only HTTP/native websocket actions. The six card games retain round results/Next; Diloti/Koum Kan provide exact read-only selection feedback. Chess is a single standard game with fixed seat colours, legal moves/promotion, draw commands and authoritative results. See [chess actions](platform-api.md#chess-participant-actions--approved-2-november-2026) and [card actions](platform-api.md#card-gameplay-integration--1-november-2026).

The repository was empty: no application, package manager configuration, database, tests, or existing conventions. This increment establishes the application and one internal Match use case. PostgreSQL is the confirmed database choice. Signup and contact verification use `pg` with explicit SQL migrations, durable users/registration sessions, and one-time code challenges; the Match repository adapter remains unimplemented. Automatic sign-in and one-click temporary accounts are implemented; password login and current-user profile metadata are now implemented, while engine actions/results and external financial operations remain pending; the later shared table/ledger increment is described below. See [account sessions](account-sessions.md). See [registration](registration.md) for the new increment.

For a visual overview, see the [system map](system-map.md). For current HTTP contracts and internal behavior, see the [API and use-case catalog](api.md).

## Approved next direction: tables and one credit currency

On 1 November 2026 the owner confirmed a shared public/private table system for all seven games, equal table/credit capabilities for generated and registered accounts, and one credit currency with durable financial accounting. The frontend may keep its Demo labels. The [table decisions and implementation sequence](multiplayer-tables.md) and [credit ledger plan](credits.md) are the current product direction; older references to non-cash exploration metadata describe the implemented counter, not a separate future currency.

Confirmed rules include automatic creator seating, one active table per account across games, public waiting/playing tables listed including full ones, private code access without a spectator feature, the existing ready button for every participant, a 0.90-credit fee plus a selected 1/5/15/30-credit contribution, atomic seat/funds/ticket acceptance, and full individual refunds before start. The owner's 2 November decision excludes completed/cancelled tables from open discovery while preserving ticket history and authorized direct links. No inactivity/abandonment timers are added. The game engine will own actual play/results; settlement remains a distinct audited, idempotent operation preserving the mandatory result-history/revision direction below.

The shared ledger/table/ticket/API/websocket foundation is now implemented; see [actual contracts](platform-api.md) and [checkpoint](backend-progress.md). Opening funding was subsequently confirmed as preserved existing balances and 250 credits for all new accounts. The owner also confirmed the no-cancel-after-any-accepted-move rule, explicit individual/team forfeit wins with no substitutions, indefinite disconnect/navigation waiting, draw contributions back with fees kept, and allowed zero-move cancellation/trusted technical void full refunds. The shared initial-result/settlement paths are now implemented and tested with controlled adapters; Xeri/Diloti engine actions are integrated; chess remains held. See [credits](credits.md). Already-paid correction handling, extra table administration and later game frontend activations remain discussion points. Every frontend change, including a tiny behavior/copy/enablement change, must be discussed and explicitly agreed before implementation. Backend technical choices remain flexible within settled behavior.

## Shared match lifecycle and initial settlement

Migration 008 adds immutable funded rosters, initial state/version snapshots, accepted event history, initial results, separate settlements and per-participant allocations. The mutable game snapshot carries a monotonic revision and accepted-gameplay count, reconciled against append-only events by deferred database constraints. The first accepted move, cancellation, forfeit, engine outcome and trusted technical void serialize on the same table lock. A terminal transaction writes its event/result, balanced journal and allocations, changes ticket state and releases active participation together. No partial payout or automatic result correction is allowed.

A session locks its account with `FOR NO KEY UPDATE`: commands from the same account still serialize while foreign-key ownership checks can acquire `KEY SHARE`. This avoids a creator-account/table deadlock when a different participant finishes a match while the creator is waiting to act. Session revocation still serializes through the existing session-row lock. Ledger accounts retain their stable global lock order.

`PlatformStore.applyGameAction` is the authenticated, version-pinned adapter boundary behind the shared HTTP/native websocket action routes. It trusts the registered server adapter's accepted state, gameplay classification and outcome, and validates whole winning sides before payment. `voidForBackendFailure` is also internal and requires a qualifying confirmed incident/evidence reference; no operator role or public authority-string endpoint is added. Existing account/cookie/origin protections apply to participant cancellation/forfeit. See [platform API](platform-api.md). The earlier winner-only Match prototype remains separate and unregistered; paid-result revisions require a distinct future authorized append-only design.

## Actual request and operation paths

Chess source lives in [engines/chess](../engines/chess/README.md), based on the retained v0.1.6 archive. Only `ArtifactChessGameRuntime` is registered for funded chess: engine `0.4.0-strict.2`, schema 3, rules `skillbetting.chess.fide-2023.strict-proof-artifacts.v1`. The default 0.3.0 and inline strict.1 adapters remain unregistered. Separate workers search/check persistent evidence, replay saved artifact references and produce both participant views. The Platform releases account/table transactions before preparation and reauthenticates/rebinds before any match/funds commit. Migration 009 stores proof checkpoints, immutable chunks/manifests and deferred event-bound references; the proof checker, not a saved JSON verdict, supplies authority. Operational cancellation/resource errors never accept an unresolved move, declare a result or trigger a refund. See the [implemented chess contract](platform-api.md#chess-participant-actions--approved-2-november-2026).

The production root module contains health, registration and the new shared Platform module. The [platform API](platform-api.md) exposes funded table/credit operations and native websockets; Xeri/Diloti actions and participant-only views are integrated; the shared lifecycle and initial settlement are now implemented. The Match service is intentionally not registered with a production repository. No Match write route is exposed. A test-only controller demonstrates the complete path without publishing ephemeral business writes:

```text
HTTP controller (test fixture)
    → RecordMatchResultService (Nest provider)
        → Match.recordResult() (ordinary domain object)
        → MatchRepository (application contract)
            → InMemoryMatchRepository (test fixture only)
```

The HTTP fixture's actor is trusted test setup, not a model for authenticating callers. Before a real controller is registered, establish caller identity, authorize the operation, and bind a durable repository. Receiving an actor ID or operation ID from a request does not establish authority.

## Decisions made for this increment

| Choice                                              | Problem solved                                                                                          | Cost and flexibility                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| NestJS 12, Fastify 5, npm lockfile                  | Working HTTP runtime, DI, and reproducible dependency resolution.                                       | Fastify-specific setup and injection tests; adapter selection can be revisited before transport integrations accumulate. |
| Strict TypeScript, ESLint, Prettier                 | Enforced typing and consistent style.                                                                   | A compile step for tests; no custom framework or Nest CLI wrapper.                                                       |
| Native Node test runner                             | Runs compiled TypeScript and Nest testing utilities on the supported local runtime.                     | No Jest mocking APIs; small explicit repository doubles suffice.                                                         |
| Ordinary application service                        | Coordinates load, domain behavior, and save without a command bus.                                      | One explicit repository dependency; introduce CQRS only when a concrete coordination need warrants it.                   |
| Pure `Match` class                                  | Keeps state transitions and invariants testable outside Nest.                                           | Explicit snapshots for persistence; no ORM decorators or framework dependencies.                                         |
| One repository interface and colocated symbol token | Lets Nest inject a persistence implementation despite TypeScript interfaces having no runtime identity. | One substitution boundary; no generic repository base classes.                                                           |
| Test-only persistence and HTTP result fixture       | Makes the full operation inspectable before committing to storage or auth.                              | Production cannot create or record Match results yet.                                                                    |
| Small result history, no event sourcing             | Preserves the initial record for mandatory authorized official outcome revisions.                       | Revisions still need a domain method and a distinct history record shape.                                                |

`new Match(id, [firstParticipantId, secondParticipantId])` is appropriate because each Match is an independent business object with its own state. Nest manages the longer-lived `RecordMatchResultService` and its repository collaborator. DI does not construct or own each aggregate.

The Match feature retains `matches/domain` plus `matches/application`. The registration feature keeps its controller, application service, PostgreSQL store, validation, and password helpers together in `src/registration`; there are no empty business modules or generic persistence abstractions.

## Match behavior and responsibility

The deliberately small state machine is `awaiting_result → result_recorded`. A Match requires an ID and two distinct participant IDs. Its result must name one of those participants as winner and contain an operation ID, recording actor, and canonical UTC recording timestamp. These identity, outcome, transition, and provenance invariants belong inside `Match`.

An original result is never replaced. The history entry contains `kind: 'initial'`, winner, actor, operation ID, and recording time. Snapshots contain frozen copies, and restoration passes through the domain invariants. Future authorized corrections must append a distinct revision record with the previous and replacement outcomes, actor, reason, timestamp, and Integrity decision reference. This increment does not implement revision authority or a correction method.

Confirmed business decision: the system must support adjusting official match outcomes while preserving previous records. Authorized outcome revisions are a mandatory requirement, not a speculative extension. Retain `MatchSnapshot.results`, the append-only history direction, and the current implementation; do not simplify the model to a single optional result. The current implementation still accepts only one initial reported winner. The revision operation, decision authority, allowed replacement outcomes, and appeal rules remain to be designed and implemented. An investigation, evidence update, verification, or sanction alone does not revise a match outcome; a revision must apply an authorized decision that changes that match's official outcome. Settlement remains a separate decision and operation.

Participant eligibility, identity, caller authorization, evidence confidence, and settlement policy belong in application-level policies or their owning business capabilities. A recorded result is a reported participant win; it is not a verified result or financial authorization. No operation performs financial work.

The win-only, two-participant model is a provisional example, not a finalized rule for all competitions. Draws, voids, teams, game-specific evidence, complete lifecycle rules, and creation workflows are not implemented.

## Retries, persistence, and future consistency

- Idempotency is scoped to `(matchId, operationId)`. Repeating the same operation with the same winner and actor returns the original snapshot and recording timestamp without saving again. Reusing its ID with different data fails; a different operation cannot overwrite the result.
- The service loads an independent aggregate, captures its version, invokes `recordResult`, and saves only a new transition. Persistence errors are surfaced to the caller.
- The repository must atomically compare the stored version with `expectedVersion`, accept exactly one version advance, and persist state plus history together. The fixture simulates this with synchronous compare-and-save inside one process. Tests show one winner in a concurrent race and reject stale saves and rollback attempts.
- A real adapter needs a database transaction or equivalent atomic conditional write and durable operation/history constraints. The fixture proves the intended contract, not cross-process, crash-safe, or production persistence correctness.
- A concurrency conflict is returned; callers must reload and retry the same operation ID. No automatic retry loop, background delivery, or in-process event guarantee is implied.
- A future result revision must never automatically reverse or repeat settlement. Settlement authorization and Wallet accounting need independent durable, idempotent, audited operations.

## HTTP and operational scope

The shared global validation pipe validates decorated DTOs, rejects undeclared properties, and avoids implicit primitive coercion. Registration now has a production write DTO; Match writes remain test-only. The test-only Match controller exercises the same pipe.

Errors use `{ statusCode, error, message, requestId }` with standard HTTP status text. Arbitrary exception messages, stack traces, paths, query values, request bodies, and header values are not returned. DTO validation errors remain generic. Known registration failures add an allowlisted `code`; arbitrary exception text is still never returned.

Nest's JSON console logger records allowlisted completion metadata: server-generated request ID, method, route template, status, and elapsed time. Unexpected request failures log only event, ID, and status. Client-supplied request IDs are not trusted. Avoid adding raw request/response objects or exception payloads to logs when extending the system.

Fastify limits bodies to 1 MiB. `/health` checks liveness only. Signup adds durable users, restricted registration sessions, exact-origin write checks, and database-backed signup attempt limits. Contact verification adds transactional challenge reservations, one-minute per-channel cooldowns, bounded attempts, and provider adapters; see [its contract](contact-verification.md). Gameplay/financial authorization, trusted proxy configuration, readiness checks, observability backends, and deployment TLS remain outside this increment. For that historical initial increment, Game Bridge, game APIs and financial operations were outside scope. The later shared table/ledger routes are now implemented as documented above; production engine actions, deposits/withdrawals and paid-result corrections remain pending; shared initial settlement is implemented.

## Owner decisions and recommended next increment

The following decisions remain open:

1. Match persistence: implement its durable repository and migrations. Registration has selected `pg` and ordered SQL migrations; it does not implement Match storage.
2. Identity and authorization: choose the initial trusted result caller, how it authenticates, and who may report results. Define the boundary before exposing writes.
3. Match rules: confirm participant representation, match creation/ownership, allowed outcomes (including draws/voids), and when recording is permitted.
4. Integrity and revisions: establish decision authority and provenance requirements before implementing an append-only revision operation.
5. Deployment: confirm runtime version policy, hosting and network exposure, and readiness/logging needs.

Recommended next increment: agree on the result-caller authorization model, implement migrations plus a durable Match repository with transactional version checking and operation uniqueness, and run repository integration tests against PostgreSQL. Then add an authorized result-recording controller with its own DTOs and HTTP tests. Keep settlement and game evidence ingestion outside that increment until their contracts are defined.

Current-user profile access and password login remain in the small registration/account feature. Reads and updates use account-token digests directly in SQL, and registration dismissal is user-level state. The frontend credits action is the large wallet presentation; it confers no financial capabilities. See [profile](profile.md).
