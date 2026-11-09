# Rummy rules engine

Headless Koum Kan, Thanasis and Biriba in one package, because the designer's game shares one rummy module between them. It follows the same shape as `engines/chess/`, `engines/xeri/` and `engines/diloti/`: immutable JSON state, deterministic transitions, replay, per-viewer observations and legal-action bots. The approved Koum Kan, Thanasis and four-player Biriba variants are registered with the live table runtime and frontend. Their integration changes no engine rules/state semantics or versions. Biriba uses four permanent seats, opposite-seat partnerships, private per-player observations and two winning IDs for the existing equal-share ledger.

From the backend repository root, run `npm ci`, then `npm --prefix engines/rummy run check`. The check builds ESM and CommonJS, checks consumer types and runs the tests. It is included in root `npm run check`.

## Which rules

On 1 November 2026 the owner decided that the designer's game wins and the seven-game rulebook only fills gaps. These rules therefore come from `card-rules.js`, `card-games.js` and `cards-rummy.js`, so Biriba plays to 2,005 rather than 5,005, and Thanasis is two players over five deals rather than four to seven players scoring to 100.

| Game     | Seats                          | Cards                    | Hand                                | Match                                                              |
| -------- | ------------------------------ | ------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| Koum Kan | 2                              | 2 packs + 2 Jokers (106) | 10                                  | Ends when someone reaches 100 penalty points; the lower total wins |
| Thanasis | 2                              | 1 pack (52)              | 10                                  | Five deals; the lower penalty total wins                           |
| Biriba   | 4, opposite seats are partners | 2 packs + 4 Jokers (108) | 11, plus an 11-card packet per team | First team to 2,005; the higher total wins                         |

In every game an exact tie for the lead at the end condition plays another round.

**All three.** A turn draws, then plays, then discards. The open card that starts the discard pile is never a Joker: a Joker goes under the stock and the next card turns up. A run takes three or more consecutive cards of a suit. An Ace plays low or high but never around the corner. A meld holds at least one natural card, and wild cards keep their exact rank and suit once down. A round ends when someone closes or after the discard that follows the last stock card.

**Koum Kan.** Sets of three or four different suits are allowed. Drawing takes the stock or the top discard. A player who has opened may lay off on any meld, and may take a Joker back with the exact card it stands for. A hand can never be emptied without a final discard. With one card in hand the pile is closed, and the new card must be kept. Ace 11, courts 10, Joker 20.

**Thanasis.** The open card names the wild rank for that deal. Draw from the stock only, with no melds on the table. Close by discarding one card and laying two triples and a four. Only hands left at the end pay, after taking out the three- and four-card melds worth the most. Ace 1, courts 10, wild 25.

**Biriba.** Melds are runs of one suit with at most one substitute, and they belong to the team. Jokers and 2s substitute, and a 2 in its own place is natural. Taking the pile takes all of it, needs a way of using one of its cards, and that use must happen before discarding. A team needs a biriba of seven or more cards before a player may go below two cards. Emptying a hand takes the team's packet: at once after a meld, or for the next turn after a discard. After that, a discard ends the round. Scores are melds plus bonuses minus hands, with 100 for closing and minus 100 for a packet not picked up. Clean or dirty biribas add 200 or 100, thirteen-card ones 1,000 or 500, doubled in the trump suit.

## Where the engine differs from the designer's code

The designer's rules text is followed everywhere. In three places its code does not do what that text says, or leaves a player stuck, so the engine differs. All three were checked case by case against the designer's own actions, as described under Validation.

1. **Taking the Biriba pile.** The designer's check for a usable pile card looks at only one copy of each card, and at lay-offs of one card. So it refuses a pile whose card could be used through the copy in the pile, or by laying off two cards together. The rule says only that a card must be usable, so the engine accepts these.
2. **A Joker laid off below a Joker.** In Koum Kan, the designer's code cannot place a new Joker below one already in the run, because it assigns wild cards from the lowest gap upwards. The engine allows the lay-off.
3. **Stranded piles.** In the designer's game a player can take the pile, spend the last card that could use it on another meld, and then have no legal move, since the discard stays blocked. There is no clock to break the deadlock, so the engine refuses the play that would strand the pile.

Choosing a reading of the cards also differs slightly: the engine removes the repeated readings the designer's picker shows, and the order of a selection never changes them.

## Integration boundary

The backend owns authentication, seat binding, transactions, revision control, settlement and forfeits. The engine has no clocks, draws or cancellation: a match always ends with one winning side.

Create a game with `createGame({ game, players, seed })`, where `game` is `koumkan`, `thanasis` or `biriba`, `players` lists every seat in order, and `seed` is 64 lowercase hex characters from a CSPRNG. The seed decides every hidden card, so it must stay private. Authoritative state contains the seed, every hand, the stock and the packets, and must never reach a client. Send players `getObservation(state, playerId)` only. Every event is safe to send to every player.

Actions are `draw`, `meld`, `extend`, `replace`, `discard` and `close`. Cards name their physical copy, such as `10D-1` or `JOKER-0`. `getMeldOptions(state, playerId, { cards, meld? })` returns the readings of a selection, and `option` picks one when submitting.

`previewSelection(state, playerId, {cards, meld?})` is an additive read-only API for the existing frontend controls. It checks the active actor, own physical cards and public meld, returns original meld-option indices with legality and discard/Joker-replacement eligibility, and uses the same validators as accepted actions. It does not enumerate capped hints or change a deal, score, ply, revision or history. The backend binds the selection to the current platform revision. No accepted transition/saved-state/rules semantics changed: engine 0.1.0, schema 1 and rules v1 remain unchanged.

A finished round stays at `round-end` with its scores visible until any seated participant submits `{type:"next"}`, the same contract as Xeri and Diloti. `next` adds a history record and a revision but does not move `ply`, and every other accepted action moves `ply` by exactly one. A match win reports `side`, `winners` and `winnerIds`, because a Biriba side is two players.

`applyAction` alone decides legality. A big hand can allow far too many melds to list, so `getLegalActions` and `legalActions` report `complete: false` when they stop short. A capped list still holds only legal actions, always includes the discards and, when a pile must be used, one way of using it. An observation took under 1ms on average and 33ms at worst in random Biriba games.

Two players can stall a Koum Kan round by passing the same discard back and forth, and two Biriba teams can avoid scoring. One player cannot do either alone, because the other can always draw from the stock. History stops at 50,000 records.

`createAnalysisGame` scripts decks, the first starter and opening scores for tests. A restored standard game refuses them. Snapshots replay from `initial` and `history` on restore, reject tampering, and require their exact engine, rules and schema versions.

## Validation

The 186 tests are written from the designer's rules, including seven exact-selection regressions. They include a full scripted round of each kind and an exhaustive search proving that the listed melds match every possible selection of a hand.

Two one-off checks on 1 November 2026 are not part of the suite, because `reference/` is local. Lockstep play against the designer's logic covered 1,100 Thanasis, 180 Koum Kan and 46 Biriba matches, about 16.9 million decisions, 14.6 million of them refusals, plus deals, melds, scoring and winners. The last 3.4 million ran on the final code, and the earlier ones on builds with the same rules. The only disagreements were the three differences listed above, each confirmed case by case: 96 pile refusals, by playing the use through the designer's own action code; 217 Joker lay-offs, by checking that the new Joker sat below the one already down; and 2,007 stranding refusals, by searching the designer's actions for any remaining use of the pile. Its bots rarely go out in Biriba, 19 of about 230 rounds, so scripted tests carry most of that ending.

Of 76 deliberately broken builds, 73 failed the tests and 1 froze a game so the run never finished. The other 2 cannot change a result that a test could see: one removes the clearer message at `round-end`, where every action already checks its phase, and one removes the rejection step from the shuffle, which matters about once in 40 million draws.
