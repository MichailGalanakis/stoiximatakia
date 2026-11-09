# Shared tables, tickets, credits and live updates

Shared funded tables, tickets, credits, authenticated HTTP/native websocket actions and initial settlement support all seven approved PvP games. Migrations 006/007 establish the one-credit ledger/tables, 008 adds permanent match history/settlement, and 009 adds chess proof persistence and event-bound references. Applied migrations remain immutable. No client result-reporting endpoint exists; computer play remains disabled. See the [checkpoint](backend-progress.md) for validation and actual deployment state.

## Chess participant actions — approved 2 November 2026

The registered chess adapter pins **0.4.0-strict.2 / schema 3 / `skillbetting.chess.fide-2023.strict-proof-artifacts.v1`**, with the separately pinned 0.3.0 movement/proof kernel. Two permanent funded seats play one standard game: seat 0 White, seat 1 Black, with White displayed at the bottom. Actual chess seat changes are refused; a current-seat request is a no-op. Analysis roots, old versions, engine resignation/adjudication and caller-supplied evidence/results are rejected. Computer play and clocks are disabled.

The existing `actions` route accepts legal `move` (`from,to`, optional `promotion` q/r/b/n and `offerDraw`), `offer-draw`, `accept-draw`, `decline-draw`, and `claim-draw` (`reason` threefold-repetition/fifty-move, optional legal `intendedMove`). An intended claim does not execute its hypothetical move. Full SAN, board/check state, captures reconstructed from public history and complete legal actions are projected only to participants. Platform forfeit uses its existing confirmed command and opposing-player win policy. Every accepted chess command is gameplay and permanently blocks zero-gameplay cancellation; rejected commands do not.

Every root/physical board move needs a verified reachability decision before acceptance. Private workers run positive optimizations and a fair persistent exhaustive fallback; incomplete/resource/cancelled work is never permission to continue. Large proofs stream through bounded chunks and a fresh PostgreSQL workset with no total proof/node/edge cutoff. Same-worker opaque checked handles bind exact roots, kernel versions and immutable artifact manifests. Saved state contains flat references, not proof bodies or trusted verdict flags. Replay/cold recovery independently checks the referenced bytes without repeating search. Proof internals never enter participant observations.

Startup and action preparation occur outside session/account/table transactions; the final transaction reauthenticates and checks the exact roster/tickets/state/revision/action/runtime before writing state, event, operation receipt and settlement. Concurrent logout, reservation replacement, forfeit/cancel or a newer move discards stale work. Exact operation retries still return the committed response, including when a losing worker fails. A cold observation cache starts verification outside the read transaction and temporarily returns the existing `503 platform_unavailable`; ordinary snapshot repair can retry. There is no new game phase, adjudication control, deadline or automatic forfeit/refund.

Migration 009 retains proof work/chunks/check namespaces/manifests and inserts immutable match references in the same deferred event transaction. `chess_proof_integrity_errors()` audits transport/bookkeeping only. Restore checking includes that audit; mathematical authority still comes from the pinned streaming checker. Public funding/participation protections and the existing draw contribution-return/fee-retention policy remain unchanged.

## Tichu participant actions — approved 2 November 2026

The sixth registered card adapter pins **0.2.0 / schema 2 / `skillbetting.tichu.nanking-four-player.v2`**. Four funded permanent seats, opposite partners and all-ready start support formats `single`, `500`, `1000`. Production seeds come from a CSPRNG; standard replay/state/format/roster checks refuse analysis, tampering and old contracts. This increment reuses current table/credit/lifecycle policies and immutable migrations.

`actions` accepts `grand` (`call` boolean), `exchange` (three `cards`, in order to next seat/partner/previous seat), `declare`, `play` (`cards,option`, plus `wish` 0 or 2–14 with Mah Jong only), `pass`, `continue`, `dragon` (`to` opposite-team seat) and explicit `next` at nonterminal round end. Grand/exchange decisions can arrive in any order; `turn` is null there and during the bomb window. Use participant `yourMove` and server-legal actions rather than assuming one actor can act. Tichu declarations and legal bombs may come out of turn. Revision/idempotency/actor guards and transaction serialization still apply.

After the passes, the public bomb window waits for **every seat with cards**, whether or not that hand holds a beating bomb. Each may play a legal bomb or explicitly `continue`; a bomb reopens play. No waiting-state eligibility depends on secret bomb ownership. No countdown, automatic decline, timeout or disconnect outcome is added. The changed window semantics require v2; v1 history is not silently reinterpreted.

`POST /tables/:tableId/selection` uses `{expectedRevision,selection:{cards,wish?}}` and returns `{revision,preview:{selection,options}}`. Options retain original `option,kind,size,value,bomb,legal`. Exact own selections are checked with accepted-action validators independently of capped suggestions, without state/history/revision/fund writes. The existing participant, origin, version and bounded-input guards remain.

The observation exposes only the viewer's hand, other hand counts, public table/combination, declarations/commit flags, finishing order, captured counts, wish and two signed team scores/rounds. Committed exchange contents, other hands, stock, seed, authoritative state/history and pending response roster stay private. `lastPlay` exchange receipts contain `{type:"exchange"}` only, including the sender's response; played cards become public. HTTP and four native websocket views enforce the same boundary; code-only visitors get no game view.

Every accepted action except `next` advances gameplay ply and permanently prevents cancellation, including the first Grand decision. Next preserves scores/ply/credits and cannot reopen cancellation. Higher team score decides the chosen format; exact ties continue. Outcomes must name both opposite teammates and settle each half of the pool once; per-viewer `ownReturnMinor` remains private. The same partnership forfeit, terminal open-list exclusion, retained tickets/direct links and durable restoration apply. See [checkpoint](backend-progress.md) and [Tichu proof](../../skillbetting-frontend/docs/verification/tichu-pvp-2026-11-02/README.md).

## Biriba participant actions — approved 2 November 2026

Biriba pins rummy `0.1.0`, schema `1`, `skillbetting.biriba.four-player-2005.v1`. Four distinct permanent players must occupy seats 0–3 and all be ready before funding/start. Partners are 0/2 and 1/3. The adapter checks every roster entry on every action; standard CSPRNG deals only. No engine semantics or migration changed.

Biriba accepts `draw` (`stock` or the whole `discard` pile), `meld` (`cards,option`), `extend` (`meld,cards,option`), `discard` (`card`) and nonterminal round-end `next`. Existing `POST /tables/:tableId/selection` checks exact own-card selections and optional public own-team meld against the current revision without changing game/funds/history. Original reading indices are preserved; capped hints are not a legality boundary. No `replace`/`close` action is accepted for this variant.

Participant projections contain their own hand only, three hand counts, public team melds/assigned wilds, trump, reserve counts/taken flags, required-pickup state for the actor, two signed team scores and round history. Physical IDs include `JOKER-0` through `JOKER-3`. Partners never receive one another's hands; stock/reserve cards, seed and authoritative/replay state stay private. Draw receipts name only the source. HTTP and native websocket views have the same participant boundary; code-only visitors cannot observe a game.

At 2,005 or above, the higher team total wins; exact ties continue. Outcomes must name both unique opposite-seat teammates. The existing settlement pays each half of the pool, once; `ownReturnMinor` remains viewer-specific. Explicit forfeit loses the entire partnership. Next preserves gameplay ply, scores and credits; no post-gameplay cancellation is reopened. Completed/cancelled tables remain accessible through authorized direct links/tickets while leaving open discovery. See [checkpoint](backend-progress.md) for full test counts and normal-match proof.

## Card gameplay integration — 1 November 2026

Extended 2 November: Xeri/Diloti use engine `0.2.0`, schema `2`, two-player rules `v2`; Koum Kan uses rummy engine `0.1.0`, schema `1`, `skillbetting.koumkan.two-player-100.v1`. Koum Kan, Thanasis and Biriba are activated from the shared rummy package, with distinct rules bindings below. Other engines remain unavailable. Starting creates a secret CSPRNG seed on the server. The standard roster is fixed in seat order; analysis/scripted deals cannot enter funded games.

- `GET /tables/:tableId/game`: permanent participants only; returns `{game,match}`. `game` contains `status` (authoritative table lifecycle), `revision` (platform version for commands), `engineVersion`, `rulesVersion` and `observation` (own hand and public engine data only). The observation's engine revision is separate from the platform revision.
- `POST /tables/:tableId/actions`: `{operationId,expectedRevision,action}`. Xeri accepts `{type:"play-card",card:"AC"}`; Diloti accepts its engine-native `lay`/`capture`/`declare` actions. Koum Kan accepts `draw` (`source: "stock" | "discard"`), `meld` (`cards,option`), `extend` (`meld,cards,option`), `replace` (`meld,card`) and `discard` (`card`). Physical copies use IDs such as `3C-0` and `JOKER-1`; Joker option assignments come from the exact selection response. All five accept `{type:"next"}` only at a nonterminal `round-end`. Any seated player may advance; the first serialized command wins. Next deals once, preserves scores and gameplay ply, and does not move credits.
- `POST /tables/:tableId/selection`: `{expectedRevision,selection:{card,table}}`, for Diloti. Returns `{revision,preview:{selection,lay,capture,declarations}}`; each option carries `legal`, `capturedCount`, `xeri`, `group`, and ten declarations are indexed by value minus one. Exact selections are checked independently of capped suggestions, using the same engine resolver as actions. Requires participant session, the usual POST Origin/client header, current revision, matching engine version and an active match. Body selection is bounded to 4096 serialized characters; the engine bounds/checks distinct current table IDs and the actor's own card. It has no operation ID, operation/event write, gameplay marker, score, credit effect or notification. Clients abort/suppress obsolete selection responses. This is not a move or a client result writer.
- Koum Kan uses the same `POST /tables/:tableId/selection` route with `{expectedRevision,selection:{cards,meld?}}`. Returns `{revision,preview:{selection,options,discard,replace}}`. Each option retains its original `option` index, `kind`, exact `slots` (`card,rank,suit,wild`) and `legal`; `discard`/`replace` are booleans for the exact selection. Requires the current actor's meld phase and distinct owned physical cards/current public meld. It uses the accepted-action validators independently of capped hints, with the same 4096-character bound, participant/revision/version/origin guards and no writes/notification. No accepted transition/state/rules semantics change; the engine version stays 0.1.0.
- WS command `action` uses the same payload and authorization as HTTP. Room snapshots and `GET /tables/:tableId` add optional `game`/`match` only for permanent participants. Command responses include the caller's private projection; exact retries return that original response. Clients must reject older revisions and repair with current snapshots.

The ordinary session/origin/header rules apply. Backend authentication supplies the actor; clients cannot choose seeds, hands, scores, dealer, winner or result. Rejected moves change no state/funds/history. All accepted gameplay actions, including the first Koum Kan draw, set the existing permanent no-cancellation marker. Koum Kan observations expose only the requesting hand, public discard/melds and a sanitized `lastPlay`; stock draws identify their source but never the newly drawn hidden card. Entire-match engine results feed the existing atomic initial settlement once. Public or code-only room access never confers a game view or action authority.

At platform forfeit/cancel/void, the saved engine observation can retain its last playing phase. `game.status` and `match.outcome` disable further actions; they are authoritative. No public void/result writer, timers, spectator access or computer-stake policy is added. The existing immutable terminal table snapshot retains roster names through `match_roster`.

## Thanasis integration — 2 November 2026

Thanasis is registered with the same authenticated actions/participant-only game routes and rummy engine `0.1.0`, schema `1`, rules `skillbetting.thanasis.two-player-five-deals.v1`. Its supplied rules already fit the approved reference controls; no engine contract/version or migration changed. Create/seat/ticket/ready, permanent roster, replay, revision checks, operation retries, forfeit and initial settlement remain shared.

The observation includes the public `indicator`/`wildRank`, own hand, opponent hand count and public discards. The pile is visible but cannot be drawn. Accepted actions are `{type:"draw",source:"stock"}`, `{type:"discard",card}`, `{type:"close",card}` and `{type:"next"}`. Closing automatically checks the remaining ten cards for exactly 3 + 3 + 4. Combinations stay hidden during play and become public only at round end. The legal-action list is complete, so Thanasis has no selection-preview route. A stock-draw receipt reveals only its source, never the newly drawn card.

Five deals determine the lowest penalty total; an exact tie continues without another entry. Round results wait for Next, which is not gameplay and cannot clear the permanent no-cancellation marker. Draw/discard/close advance gameplay once; the first accepted draw blocks cancellation. Initial result/return settles once through the existing ledger. The frontend uses the captured two-player Thanasis room; computer mode and other activations remain separate.

## Authentication and amounts

All endpoints require the valid account-session cookie for its owner. Generated and registered accounts have equal capability. Restricted registration cookies are insufficient. HTTP writes require exact `APP_ORIGIN` plus `X-SkillBetting-Client: web-v1`; reads/writes use `Cache-Control: no-store`. Request DTOs reject undeclared fields and implicit coercion. Balances/prices are integer hundredths of the one credit currency.

Existing users retain their stored balance through an append-only opening entry; every new account receives 25,000 minor units in the same transaction as account creation. `account.demoCreditsMinor` remains the compatibility name for ledger **available** credits, including profile/login/signup/session responses. `users.demo_credits_minor` is frozen import metadata and never authorizes spending. There is no public grant/refill endpoint.

## HTTP routes

Prefix: `/multiplayer/v1` on the backend. Frontend `/api` rewriting carries all seven approved human PvP controls. Browser websocket-client migration remains separate from the tested native backend/proxy transport.

| Method and path                | Input                     | Result                                                                                                                                                                                                        |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /credits`                 | Session only              | `{balance:{availableMinor,reservedMinor}}`.                                                                                                                                                                   |
| `GET /tickets`                 | Session only              | Own tickets with table ID, immutable fee/contribution and state.                                                                                                                                              |
| `GET /tables?gameId=chess`     | One supported game ID     | `{tables:[...]}` containing public `waiting`/`playing` tables for that game, including full ones; excludes completed/cancelled tables, including waiting tables closed by their final participant withdrawal. |
| `GET /tables/:tableId`         | UUID                      | `{table}` for public tables or a privately authorized viewer.                                                                                                                                                 |
| `POST /tables`                 | Create fields below       | Creator seated at index 0, full-cost reservation and ticket; `{table,balance}`.                                                                                                                               |
| `POST /private-access`         | `{code}`                  | `{table}`; grants durable private viewing/seat-selection access, without reserving/paying.                                                                                                                    |
| `POST /tables/:tableId/seats`  | `{operationId,seatIndex}` | Funded claim of an available pre-start seat; `{table,balance}`.                                                                                                                                               |
| `POST /tables/:tableId/seat`   | `{operationId,seatIndex}` | Move own pre-start seat, keep its ticket/hold, reset own readiness; `{table,balance}`.                                                                                                                        |
| `POST /tables/:tableId/cancel` | `{operationId}`           | Before start, release own full reservation and cancel the table if nobody remains seated (atomically with the release). After start with no accepted gameplay, cancel/refund the whole match.                 |
| `POST /tables/:tableId/ready`  | `{operationId}`           | Mark self ready. The last required ready action starts/captures funding only if an engine adapter exists.                                                                                                     |

Additional lifecycle routes:

- `GET /tables/:tableId/match`: permanent seated participants only; returns `{match:{revision,hasGameplay,outcome}}`. Private-code access alone is insufficient, including after completion.
- `POST /tables/:tableId/forfeit`: `{operationId,expectedRevision}`; explicit authenticated forfeit in a started match. The opposing individual/whole partnership wins. A stale active-game revision rejects without effects.

Funded-game command responses include `match` for their seated participant. A final outcome contains `id`, `kind` (`win`, `draw`, `cancel`, `void`), `reason`, `winnerUserIds`, `createdAt`, and only the viewer's `ownReturnMinor`. It exposes no incident evidence, game state, hidden hands or other players' allocation records. Revision is the platform lifecycle version, not an authorization to revise a paid result. Exact command retries return the originally stored response/balance; use current snapshots for newer state.

Create fields:

```json
{
  "operationId": "<UUID>",
  "gameId": "chess",
  "name": "My table",
  "visibility": "public",
  "formatId": "standard",
  "prizeContributionMinor": 500
}
```

Open discovery follows the owner's 2 November decision: public `waiting`/`playing` tables only, including full tables. HTTP list reads and native live lobby snapshots use the same filter; projected status is rechecked if a match finishes after ID selection. `completed`/`cancelled` tables stop appearing or contributing to the open count. `GET /tickets` still returns the owner's complete ticket history, and authorized `GET /tables/:id` plus a targeted live snapshot still expose terminal details. An individually cancelled ticket does not hide a table that remains `waiting`. No deletion, financial mutation, timer or access-policy change accompanies list filtering.

Private creation uses `visibility:"private"` and `accessCode` with 6–32 ASCII alphanumeric characters. Codes are case sensitive, keyed-digest stored and unique among waiting/playing private tables. `TABLE_CODE_SECRET` is a stable server-only key of at least 32 bytes. An absent/blank key leaves public operations available and rejects private operations with `platform_unavailable`. Never send hashes or raw codes back in snapshots. Private entry is limited to 20 attempts per minute per account and connection-IP key; failed guesses remain counted. Invalid sessions create no attempt counters.

Supported IDs: chess, tichu, biriba, thanasis, koumkan, diloti, xeri. Tichu supports `single`, `500`, `1000`; other games use `standard`. Seats are 0–1 for two-player games and 0–3 for Tichu/Biriba. The fee is 90 minor units; contributions are 100/500/1500/3000. Caller-supplied price, actor, balance and game status are rejected.

All mutating seat/table commands have a UUID operation ID scoped to the authenticated user. Exact retries return the original committed response, with its original revision/balance, without repeating financial work. Reusing the ID with different command data returns `operation_conflict`. Clients must use current snapshots to update state and avoid replacing newer revisions with a retried older response. Private-code plaintext is excluded from saved operation fingerprints.

## Table and financial lifecycle

Snapshots contain ID/game/name/visibility/revision/status, configured format/capacity, fee/contribution, seats with public player ID/name/readiness, the viewer's own ticket, participation summaries and `gameAvailable`. They contain no contacts, credentials, access code, hidden game state or other accounts' tickets. A private-code visitor can inspect/select seats but receives no spectator game access.

One active participation per account is enforced across all games by a database primary key. Seat allocation, pricing snapshot, ticket, balanced reserve postings and operation result share one transaction. Seats are unique within the table. A seat/funding/account-limit race leaves the loser unchanged. Moving a seat does not reserve again. Reserved money is unavailable to all other operations.

All required participants must be funded and ready. The final ready action takes the same table lock as cancellation. A successful start saves adapter-initialized state, transfers each participant's reserved amount into the prize pool and fee accounts, commits tickets and advances the table once. A missing engine returns `503 engine_unavailable`; that final ready action rolls back, funds remain reserved, and the table stays waiting. Previously recorded readiness remains intact. The same operation ID can be retried when an adapter is available because no failed operation was recorded.

The confirmed lifecycle policies are implemented for started matches. Any accepted gameplay action permanently blocks cancellation, across round changes and restart. Ready/seat/chat/navigation, rejected requests, exact retries and adapter-classified non-gameplay controls do not set the gameplay marker. The creator follows the same participant rules. Cancellation and the first move share the table lock; exactly one can commit. Before start, cancellation still affects only the withdrawing participant's reservation. After start but before gameplay, any seated participant may cancel the whole match with contributions and fees returned; no additional consent step is introduced.

Explicit forfeit is separate from cancellation and connection presence. An individual opponent receives the entire pool; one forfeiting teammate loses for that partnership and the two opposing teammates split the pool equally. A normal engine-authorized win uses the same distribution. A valid draw returns each own contribution and keeps the original organization fee, without charging it again. Cancellation and authorized technical void return contributions plus fees. Tickets become `settled` for wins/draws or `refunded` for full refunds; prior individually cancelled tickets remain unchanged. Terminal table snapshots preserve the permanent roster while the active-table slots are released.

Permanent roster/initial state, version-pinned accepted action history, final result, separate settlement/journal/allocations, ticket transitions and participation release commit atomically. Database constraints reconcile the move marker and event revisions, enforce policy amounts and whole winning sides, and reject incomplete results/payments. Result, roster, event, operation and financial records are append-only. Initial settlement is unique per table/result and retries cannot pay again. Paid-result corrections remain a separate future authorized revision/financial-adjustment mechanism; an already settled match cannot be voided through the initial-refund operation.

Disconnect, logout, hidden tabs and restart do not refund, remove participation or forfeit. The missing action can wait indefinitely. A valid recovered session can resume its table; generated-account cookie loss still has no account-recovery feature. There is no scheduled game/table cleanup, disconnection deadline or game clock.

## Websocket protocol

Native WebSocket endpoint: `/multiplayer/v1/live` on the backend, with the account cookie and exact browser Origin. The handshake checks the live database session before upgrade. Every command/snapshot rechecks it; revocation/expiry sends `account_session_expired` and closes with code 1008. No extra HTTP client header is required for the browser's websocket handshake. Direct backend connections are tested; the frontend/deployment proxy upgrade path remains unverified and unconfigured for this feature.

Server greeting:

```json
{ "type": "connected", "protocol": "tables-v1" }
```

Subscribe to one game and optionally one accessible table:

```json
{
  "id": "<request UUID>",
  "type": "subscribe",
  "gameId": "chess",
  "tableId": "<optional table UUID>"
}
```

Server snapshots contain `{type:"snapshot",id?,balance,tables,table}`. `table` is null when no room is selected. A subscription can receive `{type:"result",id,result:{subscribed:true}}` while a refresh is already running, followed by an unsolicited snapshot. Changed subscriptions discard obsolete refresh results. Snapshots contain real durable state, never permission to set a game phase.

Commands use `{id,type,payload?,tableId?}`. Types: `credits`, `tickets`, `create`, `private-access`, `join`, `move`, `cancel`, `ready`, `forfeit`. Forfeit payload is `{operationId,expectedRevision}`; it is never inferred from a socket closing. Payloads are the same validated DTOs as HTTP; table commands include `tableId` in the envelope. `id` correlates responses, whereas payload `operationId` is the durable retry key. Replies are `{type:"result",id,result}` or `{type:"error",id?,code}`. Raw exception text is never returned. Binary frames and unknown fields are rejected.

Limits: 16 KiB frames, 120 incoming messages per minute per connection, 32 queued commands, eight connections per session, 1,000 connections per backend instance and bounded outgoing buffering. These are transport protections, not game-time rules.

PostgreSQL `NOTIFY` announces committed table changes to each instance's `LISTEN` connection. A reconnect/subscription always reads durable state; a five-second transport refresh also repairs missed notifications and detects idle-session revocation. Listener reconnection and snapshot refresh do not change participation, tickets, funds or turns. Notifications are not a financial journal or an exactly-once event log.

## Errors and engine boundary

HTTP failures retain the shared `{statusCode,error,message,requestId,code?}` envelope. Allowlisted codes cover invalid requests, expired sessions/origin rejection, missing/unauthorized tables, unavailable seats/tables, another active participation, insufficient credits, conflicting operation retries, invalid/unavailable private codes, access limits, missing engines and unavailable persistence. Unexpected failures expose generic status text and allowlisted completion/failure logs.

`src/tables/game-runtime.ts` defines the trusted adapter registry. Start captures a permanent roster, initial state, rules version and adapter version. The `PlatformStore.applyGameAction` method authenticates the actor, loads server-owned state, serializes against cancellation/terminal commands, checks revision and exact adapter version, and accepts only the adapter's state/gameplay classification/outcome. HTTP `POST /tables/:tableId/actions` and WS `action` invoke this boundary for all seven registered adapters. Controlled test adapters remain isolated from production registration. Chess additionally requires worker-checked artifacts and asynchronous startup/action preparation described above.

`PlatformStore.voidForBackendFailure` is an internal trusted-backend operation with a durable operation ID, exact game revision, qualifying reason (`confirmed-rules-state-error` or `unrecoverable-platform-failure`) and required evidence reference. Its source/evidence are audited privately. No public void/result writer, operator role, admin UI or authority-string bypass is introduced. No runtime exception automatically invokes a void. Ordinary disconnection, losing positions or recoverable failures are not qualifying triggers. The internal trusted caller must establish the incident before invoking it.

New allowlisted failures include `game_not_started`, `stale_game_revision`, `match_ended`, `cancellation_unavailable` and `invalid_game_action`. Invalid outcomes, failed persistence or failed settlement roll the entire action back; they never fabricate a result or refund.

Validation: see `test/platform.integration-spec.ts`, `test/match-lifecycle.integration-spec.ts`, `test/match-migration.integration-spec.ts`, `test/credit-migration.integration-spec.ts`, account/session/verification regression suites, and [implementation checkpoint](backend-progress.md) for the latest actual counts and local migration status.

## Approved room recovery corrections — 2 November 2026

A final pre-start withdrawal closes the now-empty waiting table under the same table lock and transaction used by joining and refunds. Concurrent joins either take their funded seat before withdrawal, leaving a waiting occupied table, or are refused after closure with no charge. Duplicate withdrawals retain their original response. Tickets and authorized direct reads survive; no game/result/settlement is invented for an unstarted empty table.

Koum Kan/Thanasis public observations represent their two unused reserve slots as `reserveCounts: [0,0]`, matching the existing shared room contract. The engine itself retains no reserve packets for these games; Biriba packet counts, private information, saved state, rules and engine versions are unchanged. This corrects a fresh-match browser failure found during recovery verification.

On `401 account_session_expired`, the web shell invalidates its displayed account immediately, shows the existing session-expiry message in the existing sign-in dialog and returns to the same game/view/table after password login. No logout, cancellation or forfeit is issued. Successful repair clears only refresh-owned feedback; move errors and unresolved command retries remain separate.
