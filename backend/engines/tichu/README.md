# Tichu rules engine

Headless four-player Tichu Nanking. It follows the same shape as the other engines here: immutable JSON state, deterministic transitions, replay, per-viewer observations and legal-action bots. It is registered for the owner-approved Tichu PvP increment. The frontend retains the captured Tichu architecture, with four humans and all three formats.

From the backend repository root, run `npm ci`, then `npm --prefix engines/tichu run check`. The check builds ESM and CommonJS, checks consumer types and runs the tests. It is included in root `npm run check`.

## Rules

On 1 November 2026 the owner decided that the designer's game wins and the seven-game rulebook only fills gaps. These rules come from `card-rules.js`, `cards-tichu.js` and `tichu-hand.js`. Partners sit opposite, on seats 0 and 2 and on seats 1 and 3.

- Each seat sees eight cards and decides on Grand Tichu (±200). Six more follow, then each seat gives one card to each other seat. The Mah Jong holder after the exchange leads.
- A seat may call Tichu (±100) once, holding all fourteen cards and before its first play, including out of turn. It scores only for the caller going out first.
- Plays are singles, pairs, triples, full houses, consecutive pairs and straights of five or more. A reply has the same kind and size at a higher value, or passes. A passed player can come back into the trick.
- The Mah Jong ranks 1 and can make a wish from 2 to Ace. A player who can meet the wish with a legal play must, using a natural card of that rank. The wish stays until met.
- The Phoenix is a wild card outside bombs. As a single it sits half a step above the table, 1½ on a lead, and never beats the Dragon. The Dog only leads, and passes the lead to the partner. A Dragon trick goes to an opponent.
- Bombs are four of a kind or a natural straight flush of five or more. A bomb beats any ordinary play, and comes out of turn if there is a play on the table. Length wins between bombs, then value. A same-suit natural straight is always a bomb.
- Card points are 5 for a 5, 10 for a 10 or King, 25 for the Dragon and −25 for the Phoenix. The last player's tricks go to the first out and their hand to the opponents. A double victory scores 200 to 0 and stops at once. Declarations are added on top.
- The format comes from the table: `single`, `500` or `1000`. An exact tie for the lead plays another round with no new entry.

## Decisions for four real players

The designer's game has one human and three bots, so a few things had no answer for four people. These are decisions, listed so they can be changed.

1. **Grand Tichu and the exchange take any order.** The designer's bots act in seat order, which would make later seats wait and let them see earlier calls first. A committed exchange stays hidden until all four commit.
2. **Every remaining seat answers the public bomb window.** Owner approved 2 November 2026: after the passes, every seat still holding cards can play a legal bomb or explicitly decline through the existing “Χωρίς μπόμπα” control. The window opens regardless of hidden bomb ownership; it waits for all responses, with no countdown or automatic decline. A bomb reopens play. Version **0.2.0 / schema 2 / `skillbetting.tichu.nanking-four-player.v2`** changes this accepted-transition/replay contract; v1 snapshots are refused rather than silently reinterpreted. Earlier 0.1.0 waiting only on bomb holders leaked a hidden-hand fact and is superseded.

3. **A bomb cannot interrupt an empty table.** The designer's rules code allows it, but its screen and bots never offer it, and the rulebook forbids it.

## Integration boundary

The backend owns authentication, seat binding, transactions, revision control, settlement and forfeits. The engine has no clocks, draws or cancellation: a match always ends with one winning team.

Create a game with `createGame({ players, seed, format })`, listing four players in seat order. `seed` is 64 lowercase hex characters from a CSPRNG and decides every hidden card, so it must stay private. Authoritative state contains the seed, every hand, the stock and committed exchanges, and must never reach a client. Send players `getObservation(state, playerId)` only. Every event is safe to send to every player.

Actions are `grand`, `exchange`, `declare`, `play`, `pass`, `continue` and `dragon`. More than one seat may be able to act at once, so use `yourMove` in the observation to see whether the game is waiting on a player. `turn` is null during Grand Tichu, the exchange, the bomb window and at round-end. `getPlayOptions(state, playerId, cards)` returns the readings of a selection, and `option` picks one when submitting.

A finished round stays at `round-end` with its scores visible until any seated participant submits `{type:"next"}`, the same contract as Xeri and Diloti. `next` adds a history record and a revision but does not move `ply`, and every other accepted action moves `ply` by exactly one. A match win reports `side`, `winners` and `winnerIds`.

`previewSelection(state, playerId, {cards,wish?})` checks an exact own selection against the same accepted-action validator, preserving original reading indices and marking legality independently of capped suggestions. It never changes state, history, revision or funds. The adapter binds it to the current platform revision. Public action receipts omit the contents of committed exchanges; private observations expose only the actor's hand.

`applyAction` alone decides legality. An exchange has far too many choices to list, so `getLegalActions` and `legalActions` report `complete: false` there. A hand rich in straights can pass the cap of 512 too, and each Mah Jong play is listed once per wish. A capped list still holds only legal actions, and passing, declining and calling Tichu are always listed. An observation took well under 1ms on average and about 2ms at worst.

`createAnalysisGame` scripts decks and opening scores for tests. A restored standard game refuses them. Snapshots replay from `initial` and `history` on restore, reject tampering, and require their exact engine, rules and schema versions.

## Validation

The **104** tests are written from the designer's rules and the approved public bomb-response adaptation. They include scripted endings and an exhaustive search proving that the move list matches every subset of a hand.

Historical **v1** one-off checks on 1 November 2026 are not part of the suite, because `reference/` is local. They do not certify the later v2 public response contract; permanent v2 privacy/response/replay/selection regressions and backend integration now cover that change. Lockstep play against the designer's logic covered 245 matches across all three formats, 667 rounds and about 23.5 million decisions, 23.2 million of them refusals, plus its exact move list at every turn, deals, exchanges, scoring and winners, all on the final code. They included 121 bombs, 632 Dragon tricks, 446 Dogs and 212 double victories. Apart from the intended differences in who answers a bomb window, the only disagreement was the empty-table bomb listed above, seen once.

Of 62 deliberately broken builds, 60 failed the tests and 1 froze a game so the run never finished. The last removes a check that only restates the arithmetic: the Dragon ranks 0, so it can never fit a combination anyway.
