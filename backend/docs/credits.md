# One credit currency: decisions and ledger plan

Current chess release, 2 November 2026: all seven human PvP adapters share the approved ledger/settlement policy. Chess requires checked proof artifacts before startup/physical moves; operational proof failures never cause a result or refund. Migration 009 adds proof persistence/references and does not rewrite ledger migrations 006/007/008. See the [current checkpoint](backend-progress.md).

Updated 1 November 2026. Owner-approved direction and implemented backend accounting foundation. Migrations 006/007, append-only balanced journals, durable funds reservations and funded tickets now exist. See [implemented contracts](platform-api.md) and [checkpoint](backend-progress.md) for validation/local migration status. Migration 008 implements shared initial match settlement, refunds and durable result/action history. Production game integration remains held; deposits, withdrawals and paid-result corrections remain unimplemented.

## One currency and equal accounts

The product has one currency: **credits**, represented in integer hundredths (100 minor units = 1.00 credit). Every account uses the same authoritative balance, reservation, participation and settlement rules. Do not create real/demo currency types, separate Demo spending paths, browser-owned balances or preview-only financial execution in the application backend.

One-click entry creates a durable generated account with random details; ordinary registration creates an account through a different onboarding path. Both may create/join tables and pay with the same currency. Account-kind metadata may describe provenance and delivery/recovery constraints; it is not a different financial class or a gate requiring verification for this table flow. All mutations remain session-authenticated, server-priced and constrained by available funds and the one-active-table rule.

The frontend may retain its exact **Demo** currency labels. This is a presentation decision, not a separate asset or a weaker accounting model. Discuss every frontend change before making it, including changes to currency labels, balance binding or existing API response interpretation. Backend implementation should be durable and auditable as the intended final system; subsequent refactoring is expected, not a reason to simulate funds now.

Generated contacts remain internal, non-deliverable placeholders. Equal table/credit capability does not make those contacts valid destinations, add password recovery, make restricted registration cookies sufficient account credentials, or authorize arbitrary client-supplied balance writes.

## Pre-ledger baseline and migration boundary

Before migration 006 the backend stored `users.demo_credits_minor` and exposed `demoCreditsMinor`. That earlier implementation granted generated accounts 25,000 minor units and registered accounts zero. The counter has no ledger, spending, holds, transfers, refill, purchase or withdrawal operations. Older documentation describes this implemented counter as non-cash exploration metadata; that describes the historical baseline, not a separate currency in the current ledger.

Migration 006 establishes the single ledger as balance authority, locks user writes during import, and freezes the old counter. Preserve and reconcile existing values through auditable, idempotent opening entries under an agreed opening-balance policy. Do not relabel a mutable counter as an implemented financial ledger, duplicate it into two currencies, reset balances, seed repeatable free funds, or import an opening balance more than once. Existing migration files and tests remain historical implementation evidence.

The owner subsequently confirmed preserving each existing stored amount exactly once and granting **250 credits to every new account**, regardless of its creation path. Migration 006 and the account-creation trigger implement this atomically. The earlier 250/zero distinction is superseded for new accounts. Currency conversion, purchased funding, withdrawals, payment providers and free-refill amounts are also not settled by the decision to have one currency.

Keep current frontend DTO fields as compatibility aliases when practical until any frontend contract change is explicitly discussed. The underlying authority is now the ledger; `demoCreditsMinor` returns its available balance while preserving the historical response shape. No frontend component or label was changed.

## Confirmed initial table pricing

The owner confirmed the exact prices shown by the create-table preview:

- Organization fee: **90 minor units (0.90 credits)** per participant.
- Prize contribution: **100, 500, 1,500 or 3,000 minor units (1, 5, 15 or 30 credits)** per participant, selected using the existing control.
- Total cost: **190, 590, 1,590 or 3,090 minor units** per participant.
- Prize pool: participant count multiplied by the contribution; organization fees are outside that pool.

Default two-player example: each participant reserves 590 minor units. On start, 1,000 minor units fund the prize pool and 180 fund organization fees. Default four-player example: 2,000 minor units prize pool and 360 minor units fees. Use server-validated immutable price snapshots on tables/tickets so retries and future pricing edits do not silently change an existing participation.

The reference distributes the entire pool to an individual winner, or equally between two winning teammates. Apply that represented distribution only to an agreed terminal result through the settlement boundary. The owner has confirmed draw/cancellation/void amounts and the governing move/forfeit/disconnect rules below. Authorized correction handling after an already paid result remains separate. The policy update originally preceded implementation; migration 008 and the shared lifecycle now implement initial settlement with controlled-adapter verification.

The captured local computer-wallet flow separately uses a 10% draw fee (`wallet-store.js` / `game-result.js`). Its stake/multiplier model is not the multiplayer receipt's fee-plus-contribution model. Do not silently adopt that computer-play draw fee or multiply the multiplayer prize pool by the computer win multiplier. The confirmed multiplayer draw rule below supersedes that computer-play fee model: retain only the existing fixed organization fee.

## Confirmed settlement and participation rules — 1 November 2026

The owner settled the following rules in the follow-up answers. The same principles apply to all seven games, regardless of readiness flags, filled seats, backend start status, connection presence or visible screen.

### Cancellation boundary: any accepted gameplay move

**Once any gameplay move/action has been accepted anywhere in the match, cancellation is unavailable.** It cannot refund contributions or commission. Use the persisted authoritative match history/marker, not the table's `waiting`/`playing` flag, readiness, current screen, current board appearance or the current round's move counter.

Before any accepted gameplay move, the previously agreed cancellation/full-refund path remains available. Before backend start, the existing individual participation withdrawal releases that participant's entire reservation. For a backend-started but still zero-move game, the full-game cancellation path must return every participant's contribution and commission. No additional all-player consent step was selected. The creator has no special right to cancel a match after play has occurred.

A move is an engine-accepted gameplay action by a player or bot. Ready/seat/code/chat actions, page navigation, screen changes, rejected/illegal requests and duplicate command replays are not gameplay moves. The no-cancel marker persists across reconnects, restarts and round changes. **Do not add a separate automatic "cards dealt" cancellation cutoff:** the owner chose one accepted-move rule for all games. If an engine's deal/phase semantics make action classification ambiguous, map its actual accepted gameplay actions during integration without silently introducing a different product rule.

A cancellation racing with the first valid move uses the same authoritative game lock/version. If cancellation commits first, the later move is rejected because the match ended. If the move commits first, cancellation is rejected without releasing funds. Neither action may partially commit.

### Explicit forfeit versus disconnection

**An explicit forfeit ends the contest with a win for the opposing player or intact opposing team.** For individual games, the opponent wins. In a four-player partnership game, one teammate forfeiting makes that team unable to continue; the entire opposing team wins. The remaining partner does not play alone. There are no substitutions or replacement bots.

Use the ordinary winner distribution: the winning individual receives the prize pool, or the two winning teammates split it equally. The losing/forfeiting side receives no cancellation refund. The house keeps the originally captured organization fees; there is no additional forfeit fee. Record the result with a distinct forfeit reason and the authenticated actor, then settle once through the audited result/ledger boundary.

Forfeit is a deliberate, separately authenticated game command. Never infer it from a websocket close/reason, closing the browser, logout, temporary connection loss, changing screens, closing a game panel or elapsed inactivity. Those actions preserve participation and wait for the player to resume. A disconnected player remains on the roster; winner/team selection must not count currently connected sockets. Without a game-clock policy, waiting can last indefinitely.

Terminal outcomes serialize against the same game state: the first valid committed forfeit/result ends the contest; a competing later command cannot create a second winner or payout. Exact retries return the original outcome. Preserve append-only result history.

### Financial treatment

A valid **draw returns each participant's own prize contribution while the house keeps the original organization fee**. At the current default price, each player paid 5.90, receives 5.00 back and has a net cost of 0.90. That fee was already captured at start; do not charge it again or add the computer-wallet's 10% draw fee.

A permitted zero-move cancellation returns both contribution and fee. An authorized void also returns both, including a fee already captured on start. With the default price, that is a full 5.90 return to every participant and zero fee retained by the house for that game.

| Outcome                                             | Contribution / prize pool                                           | Organization fee                       | Default return                                | Owner policy                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| Valid draw                                          | Return each own contribution                                        | House retains original 0.90 per player | **5.00 per player**                           | Confirmed.                                                                   |
| Allowed cancellation with no accepted gameplay move | Return each applicable paid contribution                            | Return original 0.90                   | **5.90 per refunded participant**             | Confirmed; no cancellation after any accepted move.                          |
| Explicit forfeit                                    | Award pool to opposing individual/team under ordinary winner shares | House retains original 0.90 per player | Winning side receives pool; losing side **0** | Confirmed; no substitution.                                                  |
| Authorized void                                     | Return each own contribution                                        | Return original 0.90                   | **5.90 per player**                           | Confirmed; trusted authority and qualifying technical invalidation required. |

### Authorized voids

The owner adopted the full-refund void policy: **only the backend or a trusted operator may invalidate a match for a confirmed rules/state error or unrecoverable platform failure**. An ordinary player cannot select `void` or assert a refund amount as authority. Record the authorizing actor/system, concrete reason and evidence/reference. This approval does not create an operator role, admin UI or an unprotected void endpoint.

A void can invalidate a game even after accepted moves, because it addresses whether a valid game/result can stand. Examples within the approved technical scope are confirmed unrecoverable game-state corruption or a confirmed rules-engine defect that materially invalidates play/result and cannot be repaired/replayed. A recoverable restart or transient error uses saved state and replay. A normal disconnect, inactivity, losing position, rejected move or ordinary client error does not qualify and must not automatically trigger a void.

Refunds require new balanced journal entries returning contributions from match funding and any captured commission from fee funding. Preserve the original capture/result records. Initial settlement/refund must commit atomically with terminal state, ticket updates and active-participation release, and remain idempotent across retries/restarts.

Invalidating a previously paid result remains a distinct authorized outcome-revision/correction case with separate financial adjustment authority. Do not reuse an initial refund operation to pay twice, rewrite history or silently reverse an existing payout.

### Implementation and frontend boundary

The shared backend now implements the accepted-gameplay cutoff, explicit individual/team forfeits, draw/win settlement, zero-move whole-match cancellation and internal trusted technical voids. Migration 008 adds immutable roster/history/result/settlement records and deferred reconciliation checks. The initial state and exact adapter/rules versions are retained for replay. Terminal result, ledger journal, allocations, ticket state and participation release commit together and are idempotent. Existing ledger/account funding behavior remains unchanged.

`GET /tables/:tableId/match` is limited to permanent seated participants. Explicit forfeit is available as an authenticated HTTP/WS backend command with an expected game revision. There is no public outcome/void writer. The technical-void method is a trusted internal backend boundary requiring a qualifying incident/evidence reference; no operator role or UI was created. Already-paid outcome corrections are intentionally not implemented by this initial settlement path.

All seven human rules adapters and authenticated gameplay-action endpoints are enabled, including strict.2 proof-backed chess. Controlled test adapters exercise the shared lifecycle alongside real-engine integration tests; computer play remains disabled. See [platform API](platform-api.md). Migrations 006/007 remain immutable; actual application/validation of 008 is recorded in the checkpoint.

No frontend control, text, navigation or behavior changes are authorized by this policy confirmation. In particular, do not silently turn a cancellation/close/navigation control into a forfeit action or add new consent/void/forfeit UI. Inspect the reference and discuss each concrete frontend change first.

## Confirmed ticket and reservation lifecycle

1. Creation automatically seats the creator. Creation plus creator seat, active-table slot, full-cost reservation and ticket commit in one PostgreSQL transaction.
2. Another participant selects a free seat and confirms using the existing purchase action after frontend activation is discussed. The same atomic transaction claims the seat and one-table slot, reserves the complete server-owned price and issues the ticket.
3. Reserved credits are unavailable to every other spending operation. They remain the same currency. Ticket issuance is not an additional charge.
4. Insufficient available funds, a seat race, another active table, rejected authorization or a failed transaction leaves funds, seats and tickets unchanged. Exact retries return the original outcome and never repeat its monetary effect.
5. A pre-start seat change moves the same participation/ticket without another charge.
6. The final required ready action starts a game only if all seats are funded, all players are ready, and the engine is integrated. Starting transfers held contributions/fees into their appropriate ledger accounts exactly once.
7. Cancelling participation before start releases **the entire reservation, including the fee**, and releases the seat and active-table slot. Start and cancellation race against the same locked/versioned state; neither can partially win. Repeated cancellation cannot refund twice.
8. A disconnect, hidden tab, refresh or backend restart does not release money, create another ticket, forfeit, or impose an expiry. The owner deliberately defers timers. Restore the existing account-owned ticket/reservation and game state on reconnect.
9. After start, settlement follows an agreed result and authorized policy. It is independently idempotent and audited. An outcome revision preserves previous results and must not automatically duplicate payouts or reverse settled funds.

The individual pre-start release, accepted-move cancellation cutoff, explicit forfeit/team loss, indefinite disconnect wait and draw/cancel/void financial treatments are settled above. A creator follows the same rules as another participant and gains no in-play cancellation power. Any proposed whole-table administration beyond these ordinary participant operations, or correction of an already paid result, requires its own authorized design.

## Backend implementation requirements

Use one coherent ledger in PostgreSQL with balanced journal transactions and durable reservations. Every grant, opening entry, hold, release, fee capture, pool funding and payout needs an operation identity and provenance. Account balances may use transactional projections for efficiency but must reconcile to the journal; the old user counter and the journal cannot both independently authorize spending.

Enforce integer bounds, non-negative spendable funds, account/table/seat consistency and exactly one active participation across games through database constraints plus appropriate transaction locking/version checks. Persist the complete financial effect and its domain transition together where possible. Publish live notifications after commit and recover missed notifications from durable state; websocket delivery is not the financial record.

Use server-owned account identity, configuration and result authority. Ignore client claims about amount, role, balance, verification, winner or settlement status. Keep opaque credentials, codes, contact details and raw payment/provider payloads out of public room responses and logs. Backend technical choices may evolve while these invariants remain.

Money tests must prove conservation/reconciliation, concurrent overspending prevention, funded seat and ticket atomicity, rollback on injected failure, retries after a lost acknowledgment, duplicate release/start/settlement prevention, process restart, and migration import idempotency using isolated synthetic ledgers/accounts. UI activation needs separate source comparisons and explicit owner agreement.

See [table decisions and implementation sequence](multiplayer-tables.md), [current account sessions](account-sessions.md), [system map](system-map.md), and [architecture](architecture.md).
