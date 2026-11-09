# Multiplayer tables: decisions and implementation plan

Current chess release, 2 November 2026: the owner-approved human-only chess frontend and strict.2 artifact runtime are enabled. Two fixed colours, existing public/private tickets/readiness, checked legal moves, draw commands and shared settlement are connected. Computer play remains disabled; proof search has no unknown-as-playable fallback. See the [chess API](platform-api.md#chess-participant-actions--approved-2-november-2026) and [current checkpoint](backend-progress.md). Older dated availability notes retain their historical scope.

Current Tichu activation, 2 November 2026: all six card games now have explicitly approved frontend/runtime integrations. Tichu uses the same four-seat/opposite-partner foundation as Biriba, with single deal, 500 and 1,000 formats and equal winner shares. Every remaining hand explicitly answers its public bomb window; no timer is introduced. First accepted Grand/exchange/declaration/play/pass/response is gameplay for cancellation; Next never resets it. Exact format/private actor/replay/result checks are in the [Tichu proof](../../skillbetting-frontend/docs/verification/tichu-pvp-2026-11-02/README.md). Chess's separate release hold remains. Older dated availability notes retain their historical scope.

Current activation, 2 November 2026: Xeri, Diloti, Koum Kan, Thanasis and owner-approved Biriba use real table/game adapters and the existing frontend. Biriba requires all four funded seats ready, keeps opposite-seat partnerships and pays half the pool to each winning teammate. Private-code access alone grants neither a ticket nor private game access. Engine contracts, cancellation cutoff, fees, ledger and migrations remain unchanged. See [Biriba proof](../../skillbetting-frontend/docs/verification/biriba-pvp-2026-11-02/README.md). Older dated activation statements below retain their historical scope.

Updated 2 November 2026, including the owner's completed/cancelled table discovery decision. The shared backend ledger, funded tables/tickets, session-bound APIs and native websocket foundation are now implemented. See [platform API](platform-api.md) and [checkpoint](backend-progress.md) for actual validation/local migration status. The shared lifecycle and initial settlement are also implemented through migration 008 and controlled-adapter tests. Xeri/Diloti/Koum Kan/Thanasis adapters, authenticated actions and approved PoC frontends are integrated. Other game frontend activations and adapters remain separate increments.

## Authority and frontend boundary

Implement one shared public/private table system for all seven games before integrating each VS engine. Build actual durable backend behavior against the supplied frontend experience. The designer's Demo wording does not make backend accounts, credits, seats, tickets, or results disposable simulations.

The working frontend is `/Users/tsal/Projects/skillbetting-frontend`; the immutable source is its `reference/stoiximatakia/public/` capture, release `play-modes-436b2471a5f3`, 30 October 2026. Main lobby, accounts, and wallet presentation have been migrated to React. The approved Xeri/Diloti/Koum Kan mode/table/waiting-room and actual game rooms are migrated; other game frontend activations still require their own agreement.

**Discuss and obtain the owner's explicit agreement before every frontend change or addition, however small.** This includes text, labels, controls, disabled/enabled states, behavior, navigation, data binding, removal of preview controls, and changes that preserve the same appearance. Prepare a concrete source-backed proposal first. This requirement supersedes earlier guidance allowing routine frontend choices without discussion. Backend implementation choices within agreed behavior remain flexible; discuss material policy gaps or blockers. Documentation updates do not authorize additional frontend implementation.

Preserve the reference and checksum manifest unchanged. Preserve existing layout, CSS, assets, controls, and responsive behavior. Do not add a homepage table feed, alternative game formats, spectator controls, notices, clocks, or other UI without discussion. The owner expressly allows existing Demo credit branding to remain while the backend uses one currency.

## Confirmed owner decisions

| Topic                     | Agreed behavior                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Currency                  | One credit currency and one financial accounting model for every account. No separate real/demo balances or payment paths. See [credits](credits.md).                                                                                                                                                                                                                                                                                             |
| Accounts                  | Generated one-click accounts and registered accounts have equal table/credit capabilities. Creation method is not an eligibility tier. Require a valid account session and sufficient available funds, not contact verification or identity approval for this agreed table flow.                                                                                                                                                                  |
| Creator                   | Successful creation seats the creator automatically and issues the creator's funded ticket. The existing seat picker supports changing to another empty seat before play.                                                                                                                                                                                                                                                                         |
| Participation limit       | An account may participate in only one active table across all seven games. Browsing details or receiving private-table access does not itself occupy a seat.                                                                                                                                                                                                                                                                                     |
| Private entry             | A correct code grants access to table details and the opportunity to take an available seat. It does not reserve a seat. First successful funded seat claim wins.                                                                                                                                                                                                                                                                                 |
| Spectators                | No spectator feature was found in the reference table flow. A visitor without a seat stays at the existing table/seat-selection screen, including when the table is full. No game-view or hidden-hand access follows from code entry alone.                                                                                                                                                                                                       |
| Listing                   | Show public tables in `waiting` or `playing`, including full tables. When the final seated player withdraws from a `waiting` table, cancel that table atomically; keep it open while any player remains. Hide `completed` and `cancelled` tables from open discovery/counts; retain their tickets and direct details links. Private tables stay out of public discovery. Existing search/format/budget controls and seat/join permissions remain. |
| Readiness                 | Start only when every required seat is occupied/funded and every seated player has pressed the existing **Είμαι έτοιμος** button. This follow-up answer resolves the earlier preference for automatic start on filling seats. No extra readiness notice/control is added.                                                                                                                                                                         |
| Prices                    | Organization fee is **0.90 credits per player**. Creator chooses a per-player prize contribution of **1, 5, 15, or 30 credits**, using the existing selector. These are now authoritative initial backend prices, not merely fixtures.                                                                                                                                                                                                            |
| Payment/ticket            | Seat claim, full-cost funds reservation, ticket issuance, and the one-table limit commit atomically. Creation performs the same operation for the creator. Insufficient funds or a conflicting seat/table request changes none of these.                                                                                                                                                                                                          |
| Before-start cancellation | Cancelling participation before game start releases the full reserved amount, including the organization fee, and releases that seat/active-participation slot. A concurrent start/cancel must resolve atomically.                                                                                                                                                                                                                                |
| Timers/lifetime           | Add no table expiry, inactivity clock, disconnect deadline, automatic abandonment loss, bot substitution, or timed cleanup rule. The reference table flow defines none.                                                                                                                                                                                                                                                                           |
| Disconnect                | Preserve seat, ticket, funds, game state, and turn across a disconnect or restart. Wait for the missing player's required action indefinitely. Connection loss is not cancellation, resignation, refund, or permission to replace that player.                                                                                                                                                                                                    |
| Game integration          | Implement the common table foundation first; attach each engine separately, starting with chess. A stored/funded table is not proof that its game engine is playable.                                                                                                                                                                                                                                                                             |

### Confirmed move/forfeit/void rule

The owner's follow-up settles the governing rule for every game: **after any accepted gameplay move/action, no cancellation**. Readiness, occupancy, backend start, round boundaries and screen state do not reset or replace that condition. Before any accepted move, the full-refund cancellation policy remains applicable; do not substitute a separate cards-dealt cutoff. The creator follows the same participant rule.

After play, an explicit authenticated forfeit awards the win to the opposing player or intact opposing team; one team member forfeiting makes that entire team lose, with no substitution or solo continuation. Normal winner/pool distribution and organization fees apply. Browser closure, disconnect, logout and changing screens never imply forfeit or refund; preserve the roster/state and wait indefinitely without introducing a clock. Presence is not winner selection.

A valid draw returns each contribution while retaining the original 0.90 fee. Allowed zero-move cancellation refunds the full paid amount. An authorized technical void refunds contribution plus fee; only the backend/trusted operator may declare it for confirmed rules/state errors or unrecoverable platform failure. Disconnect/losing position does not qualify. See [credits](credits.md) for amounts, authority, races and the current implementation boundary. These policy confirmations do not activate a frontend control or settlement endpoint.

Owner decision, 2 November 2026: finished tables leave the open list. Both HTTP discovery and live lobby snapshots return only public `waiting`/`playing` tables, rechecking projected status if a match ends during loading. Historical tickets and direct authorized table reads remain available. Cancelling an individual pre-start ticket leaves a still-waiting table discoverable; this decision does not close it.

The one-table rule concerns concurrent active participation, not historical tickets/results. Completion or an authorized cancellation releases that participation slot while preserving history. A disconnected account still occupies its active slot. The first implementation intentionally permits indefinite waiting; do not introduce a timer to resolve it without discussing that change.

## What the reference actually contains

Paths below are relative to the frontend capture directory.

| Source                                                                 | Evidence                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `play-modes.js`                                                        | Shared mode selection, per-game table lobby, create form, private-code form, seat/ticket details, waiting room, readiness button, chat, cancellation, feedback and preview controls. |
| `multiplayer-model.js`                                                 | Seven-game catalog, public/private visibility, seat validation, revision/status and cost display helpers.                                                                            |
| `multiplayer-service.js`                                               | Preview and optional read-only adapter. Write capabilities are disabled and subscriptions do nothing; proposed URLs are not existing backend contracts.                              |
| `multiplayer-fixtures.js`                                              | Example tables, players, distributions, and previously illustrative fees/cancellation copy. Owner decisions above establish the prices; fixture code itself remains unchanged.       |
| `card-games.js`                                                        | Reference capacities, teams and displayed targets for six card games.                                                                                                                |
| `play-modes.css`, `chess-room.css`, `chess-arena.css`, `card-room.css` | Presentation to preserve when an explicitly discussed migration begins.                                                                                                              |

Existing flow:

1. Open a game's existing play action and mode selector; select play with players.
2. Browse that game's existing **Open tables** lobby. No new homepage section is needed.
3. Create a public/private table using its existing name, visibility, code, format, contribution and summary controls; or open a public table; or enter a private code.
4. Inspect seats and costs, select a free seat, and use **Αγορά εισιτηρίου** (buy ticket). Merely selecting a square/seat in the form is not a durable seat reservation. The actual funded claim uses this confirmation; creation confirms the creator's claim through the create action.
5. Enter the existing waiting room. Other visitors stay on the details/seat screen without game participation.
6. Press the existing **Είμαι έτοιμος** button. The final required ready action starts exactly one game, if the engine is available.
7. Actual game state and results are owned by the backend/engine, with history retained.

The reference's separate **Προεπισκόπηση τραπεζιού** action does not reserve seats or buy tickets. Its preview functions cannot be reused as real purchase commands. The exact frontend wiring of these existing controls must be discussed before implementation.

## Shared configuration for seven games

| Game     | Seats | Teams                                  | Existing displayed format/target         |
| -------- | ----- | -------------------------------------- | ---------------------------------------- |
| Chess    | 2     | Individual                             | One game.                                |
| Tichu    | 4     | Two teams; opposite seats are partners | Single deal, 500 points or 1,000 points. |
| Biriba   | 4     | Two teams; opposite seats are partners | 2,005 points.                            |
| Thanasis | 2     | Individual                             | Five deals, lower score wins.            |
| Koum Kan | 2     | Individual                             | Limit 100, lower score wins.             |
| Diloti   | 2     | Individual                             | 61 points.                               |
| Xeri     | 2     | Individual                             | 151 points.                              |

Preserve these supplied choices for table work. Engines own legal actions, card dealing/hidden information, turns, scoring, rounds and terminal outcomes. Do not implement seven copies of table membership or infer additional variants from the rulebook.

## Simple private-code and seating design

Use the existing creator-entered **6–32 ASCII alphanumeric** code field. Proposed implementation choice: exact, case-sensitive matching, uniqueness among nonterminal private tables, keyed-digest lookup/storage, generic failed-entry feedback and bounded attempt limits. No new invite-link screen, generated-code-only flow, code timer or spectator role is needed. Duplicate creation fails through the existing error area without revealing another table's code or identity.

Successful entry creates durable account-bound viewing access to that private table, not a seat/ticket. Enforce seat acquisition separately in one database transaction. Do not expose codes, other players' contacts, tokens or hidden game data in public responses or logs. Session expiry/logout revokes authenticated operations; reconnecting with a valid session restores the account's existing participation. Transport identity is never a replacement for account identity.

Creation allocates an initial seat deterministically; changing to another available seat before play moves the existing participation/ticket without charging again. A seat change invalidates the mover's readiness so the new position is explicitly confirmed. In-play seat switching is excluded because it would change participants' sides/teams; any different behavior requires discussion.

Implement the one-active-table invariant durably across games and backend processes. Serialize account/seat/funds updates so two simultaneous requests cannot create duplicate seats, double-spend, exceed capacity or bypass the account limit. A game-start operation and cancellation operate on the same locked/versioned state: exactly one can win. Never accept a client-supplied price, balance, player identity or game phase as authority.

Connection presence is separate from table/game phase. Keep the underlying game state while it waits for a required action; no new paused UI/state is necessary. Where a game's rules allow an action despite another player's absence, the engine still decides legality. Do not invent progress for a missing player.

## Tickets and prices in plain language

The reference receipt separates an organization fee from the money contributed to the prize pool. Both use the same currency.

| Per player         | Low      | Default  | Higher    | Highest   |
| ------------------ | -------- | -------- | --------- | --------- |
| Organization fee   | 0.90     | 0.90     | 0.90      | 0.90      |
| Prize contribution | 1.00     | 5.00     | 15.00     | 30.00     |
| Total reserved     | **1.90** | **5.90** | **15.90** | **30.90** |

At the default contribution, two players reserve 5.90 each: **10.00 credits** belong to the prize pool and **1.80 credits** are organization fees. Four players reserve 5.90 each: **20.00 credits** prize pool and **3.60 credits** fees. The multiplayer receipt awards the full pool to the individual winner or splits it equally between the two winning teammates. Preserve those displayed distributions; the owner has now confirmed that a draw returns each participant's contribution and retains the original organization fee. See the settlement decisions in `credits.md`; shared initial settlement now implements these amounts, with controlled-adapter tests while real game integration remains held. The separate local computer-wallet/result flow has a 10% draw fee, but its stake model is different; do not silently apply it to multiplayer. See [credits](credits.md).

A ticket is the durable participation record tied to the account, table, seat and agreed price. A reservation makes those credits unavailable for any other operation; it is not another currency. The creator pays through the same mechanism on creation. Funds and seat/ticket are accepted together or all rejected together.

At start, move the reserved contribution into match funding and the fee into its proper ledger account, exactly once. Before start, cancelling releases the whole reservation. After start, disconnecting or closing the screen does not automatically refund or release anything. Draw settlement will return each participant's own contribution and retain the fee. Allowed cancellation before any accepted gameplay move returns contribution plus fee; once a move exists, cancellation is unavailable. Explicit forfeit awards the opposing player/team the win with normal pool/fee treatment. Authorized technical voids return contribution plus fee under the approved backend/trusted-operator authority. Disconnect and screen changes preserve the game and wait, with no automatic refund or forfeit. The source's unpublished cancellation text does not settle those cases.

## Preview wording and controls: concrete explanation

The earlier phrase "live mapping" refers to actual existing elements:

- **ΠΡΟΕΠΙΣΚΟΠΗΣΗ ONLINE** and **ONLINE ΠΑΙΧΝΙΔΙ · ΠΡΟΣΕΧΩΣ** badges.
- Statements that online participation is disabled, no seat is reserved, or no credits are charged.
- A room **Προβολή κατάστασης** selector that lets a demo viewer manually select waiting/playing/disconnected/settling/completed/cancelled.
- Disabled create, code-entry, purchase, readiness, cancellation and chat controls.
- Existing loading, empty, error, summary and feedback areas.

The state selector is a preview tool, not permission for a player to declare a real game completed or a refund due. Its selected value must never control backend state. Likewise, a preview-room button cannot silently become a paid-entry action. Existing **Demo currency naming** is expressly allowed to remain; changing any wording, removing a preview selector, enabling a button, or binding it to real activity must be individually discussed before changing the frontend. This documentation does not approve those UI changes in advance.

## Comparison requested by the owner

Chess.com's [open challenges](https://support.chess.com/en/articles/8705837-what-is-an-open-challenge) show discoverable game requests that another player can accept. Its [abandonment documentation](https://support.chess.com/en/articles/8593801-how-does-game-abandonment-work) also describes first-move and disconnect timers in addition to game clocks. Checked 1 November 2026.

These pages are a behavioral comparison, not our design source. The owner's subsequent answer chooses the ready button already present in our reference. The owner deliberately defers clocks and abandonment deadlines; do not import Chess.com's timers or UI. The reference chess card expressly says **Χωρίς χρονόμετρο** (without a clock).

## Remaining discussion points

Do not reopen settled account equality, currency split, prices, creator auto-seating, one-table limit, readiness, public-list occupancy filtering, spectators or inactivity timers without new evidence or owner direction.

Before their implementation, discuss:

1. Concrete frontend activation/migration changes, including each preview-only element and existing action above.
2. Paid acquisition/withdrawal behavior remains separate. Opening funding is now settled: preserve existing balances, and give all new accounts 250 credits. See [credits](credits.md).
3. Integrate and test the confirmed accepted-move cutoff, explicit forfeit/team result, indefinite disconnect wait and draw/cancel/void settlement rules in [credits](credits.md). Their product policies are settled; authorization mechanisms, engine adaptation and already-paid outcome corrections still require implementation/design.
4. Any proposed extra creator/administrator whole-table operation beyond the normal participant cancellation/forfeit rules. The creator gains no privileged in-play cancellation right; the existing pre-start individual release remains individual.
5. Session-cookie loss for an unrecoverable generated account: preserve the funds and participation, do not add an abandonment rule or assume ownership from a username/code. Recovery/account conversion is separate.
6. Availability of a game's engine before accepting live funded tables that can reach the start condition. Do not pretend every game works because its room exists.
7. Any gameplay ruleset conflict that changes a supplied player count, target or existing interaction.

The supplied `/Users/tsal/Downloads/seven_games_rulebook_en.md` is a rules reference, not implementation authorization. Biriba's selected chapter targets at least 5,005 rather than the UI's 2,005. Thanasis's chapter selects 4–7 players and positive scoring to 100 rather than the UI's two-player, five-deal lower-score profile. Resolve/version these before their engines; preserve the reference during table work.

## Implementation sequence

### 1. Finalize behavior and existing-screen mapping

Use the decisions above as the baseline. Resolve only the remaining decisions needed for the next increment; document proposed command/response/error shapes and websocket events before exposure. Prepare exact screen/control changes for owner discussion. No schema or endpoint is claimed implemented by this plan.

### 2. Implement the one-currency ledger — backend foundation completed

Add durable integer-unit ledger accounts, journal transactions, reservations, balance queries, ticket pricing snapshots and idempotent operations. Use PostgreSQL transactions/constraints, explicit migrations and auditable opening entries; replace metadata-only balance authority through a deliberate migration. Preserve current frontend fields as compatibility aliases until discussed changes are approved. Test money conservation, rejected overspending, concurrent claims, rollback and exact retries.

### 3. Implement common tables and funded participation — backend foundation completed

Add shared game configuration, tables, seats/active participation, private access, tickets and atomic create/join/move-seat/cancel operations. Enforce creator auto-seating, equal account capability, one active table, fixed initial pricing, private-code protections and complete pre-start release. Keep every authoritative write server-owned. Test all seven capacities/formats and concurrent account/last-seat/start-cancel races against PostgreSQL.

### 4. Implement live updates, readiness and restoration — backend foundation completed

Add authenticated lobby/table subscriptions and command validation. Publish committed state; missed updates must recover from durable snapshots/revisions. Bind ready actions to participants and start only once when full/funded/all ready and the engine is integrated. Preserve state on disconnect/restart; impose no game/table expiry timers. Basic reconnect restores existing identity and state, not a reconnect deadline.

### 5. Migrate/connect the existing frontend after discussion

Implement only the explicitly agreed screen/control changes, retaining the original presentation and existing navigation conventions. Reuse supplied create, code, table/ticket, waiting, ready, cancellation and feedback elements. Chat already has a source control, but its functionality and activation are a separately identified part of this scope, not an invented feature. Compare source and working screens at the established desktop/tablet/mobile sizes. Keep the capture immutable.

### 6. Integrate VS engines and settlement progressively

The shared lifecycle/initial-settlement portion is now implemented: immutable roster/start state/action history, accepted-gameplay cancellation cutoff, explicit forfeit/team wins, draw contribution returns, zero-move full refunds and internal technical voids. These are tested with controlled adapters across the seven configured games; they do not claim those games' rules engines are integrated. Permanent participants can read their match summary. Forfeit is a deliberate HTTP/WS command; no gameplay, public result-reporting, operator or void route is enabled. See [actual contracts](platform-api.md) and [checkpoint](backend-progress.md).

Owner priority: rules correctness and reusable backend/multiplayer validation, saved state, replay and outcomes are acceptance requirements. Bot strength, difficulty and style are deferred; a simple legal selector is sufficient for later computer play. Bot actions must still obey the same rules and player-information boundaries. Preserve engine review holds and evidence; a weak bot is not a reason to delay a correct engine, while stronger play does not compensate for a rules defect.

The owner subsequently selected Xeri first, then Diloti as the next frontend candidate, using the common participant/game/funding boundary. Chess remains held until its strict rules acceptance is resolved. Adapt each engine to the supplied frontend variant and interactions rather than redesigning the frontend around the engine. Preserve full chess move history and result provenance. Extend the winner-only internal Match prototype for agreed outcomes and durable storage while retaining append-only history and the mandatory authorized-revision direction. Settlement is a separate audited, idempotent ledger operation; a result revision must never automatically duplicate or reverse settlement. Decide unresolved outcomes before enabling their financial treatment.

## Acceptance and current status

Acceptance must cover equal capabilities for both account creation paths; public waiting/full/playing visibility; completed/cancelled exclusion from HTTP/live open lists while preserving tickets/direct links; private invisibility/code-only access; no spectator/game access for unseated visitors; creator auto-seat and free seat movement without another charge; one active table across games; atomic reservation/ticket/seat; exact prices; full pre-start release; insufficient credits with no partial mutation; all-player readiness and one start; duplicate commands; concurrent last-seat and start/cancel races; reconnect and process-restart persistence; and absence of unapproved expiry/implicit-forfeit behavior. Engine integration must additionally test first-move/cancel races, move history across rounds/restarts, explicit individual/team forfeits, zero financial effect from disconnect/navigation, trusted void authority and idempotent terminal settlement. Financial tests must use isolated test ledgers and synthetic accounts.

Backend foundation code and isolated tests are present; actual checks and local migration status are recorded in the checkpoint. The approved Xeri frontend and real Xeri/Diloti adapters are implemented; no deployment was performed. Shared initial payouts/refunds now exist; the approved strict.2 chess frontend/runtime is enabled in the current release. Reference-integrity checks are independent of gameplay/visual verification. See [API](api.md), [system map](system-map.md), [architecture](architecture.md), [account sessions](account-sessions.md), and [credits](credits.md).
