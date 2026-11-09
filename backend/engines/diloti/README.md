# Diloti rules engine

Headless two-player Diloti to a 61-point match. It follows the same shape as `engines/chess/` and `engines/xeri/`: immutable JSON state, deterministic transitions, replay, per-viewer observations and legal-action bots. The backend registers this engine with the shared table runtime; Diloti PvP frontend activation is implemented.

From the backend repository root, run `npm ci`, then `npm --prefix engines/diloti run check`. The check builds ESM and CommonJS, checks consumer types and runs the tests. It is included in root `npm run check`.

## Rules

The rules come from section 6 of the supplied seven-game rulebook. Its traditional two-player baseline and the designer's in-game rules (`card-rules.js`, `cards-fishing.js`, `fishing-combinations.js`, `fishing-score.js`) agree on the points below.

- Six cards each and four table cards. A layout with three or four equal court cards is replaced. The same starter leads all four batches.
- A numeral captures disjoint sets of loose cards summing to its value. Captures are optional.
- A court captures exactly one loose court of its rank, and must do so when one is available.
- A plain declaration sums the played numeral and table cards to at most 10, keeping another card of that value in hand. An opponent may raise it while holding the new value.
- A group joins components of one value. It cannot be raised, but any player may add a same-value component, which transfers the obligation.
- A declaration is taken only at its exact value, never inside a larger sum.
- Until a declaration is resolved, its owner cannot lay a loose card or start another, and must keep a capture card.
- A capture emptying the table scores a 10-point xeri, except on the round's first play. Leftovers go to the last capturer and never score one.
- Scoring gives 1 per Ace, 2 for 10♦, 1 for 2♣ and 4 for more cards, so 11 ordinary points per round, or 7 at 26-26.
- At a completed round, the higher total at or above 61 wins. An exact tie plays another round.

The variants in rulebook 6.6 are not implemented: forced capture, self-raising, soy, broader plain captures, opening xeri and other targets. Neither is the four-player partnership game, because the table catalog gives Diloti two seats. The first dealer is drawn from the secret seed, and the existing reference “Επόμενη διανομή” interaction is preserved: a completed nonterminal round stays at `round-end` until a participant submits `{type:"next"}`.

## Integration boundary

The backend owns authentication, seat binding, transactions, revision control, settlement and forfeits. A platform forfeit stays outside the engine. The engine has no clocks, draws or cancellation: a match always ends with one winner. `ply` is nonzero once any card has been accepted.

Card actions are `lay`, `capture` and `declare`. `capture` and `declare` name table item ids: the card for a loose item, `declaration-<ply>` for a declaration.

Pass `players` in seat order and a `seed` of 64 lowercase hex characters from a CSPRNG. The seed decides every hidden card, so it must stay private. Authoritative state contains the seed, both hands and the stock, and must never reach a client. Send players `getObservation(state, playerId)` only. Every event is safe to send to both players.

`applyAction` alone decides legality. A crowded table can allow far too many selections to list, so `getLegalActions` and `legalActions` cap at 256 actions per card and report `complete: false` when they stop short. A capped list still holds only legal actions, and a player can still submit any legal selection it omits. The largest table seen in testing took about 17ms to list.

`previewSelection(state, playerId, {card, table})` supplies exact read-only selection feedback for the existing frontend buttons and declaration values 1–10. It restores/binds the requesting player and invokes the same `resolvePlay` used by accepted actions, independently of the capped suggestion list. It returns only the echoed own-card/public-item selection and legal/capture/xeri/group metadata. No next deal, score, history, revision or funds change. The backend binds it to the current platform revision through a private selection endpoint. This additive read API changes no accepted action, saved state or rules semantics, so engine/schema/rules versions remain 0.2.0/2/v2.

`createAnalysisGame` scripts decks and opening scores for tests. A restored standard game refuses them. Snapshots replay from `initial` and `history` on restore, reject tampering, and require their exact engine, rules and schema versions.

## Validation

The 105 tests cover the rulebook sections and the frontend round-control boundary. They include one complete scripted round and an exhaustive search proving the action list matches every possible selection on small tables. Historical v0.1.0 one-off checks on 1 November 2026 are not part of the suite, because `reference/` is local; they predate the explicit round-control lifecycle. Lockstep play against the designer's logic agreed across 630 matches and about 9.6 million legal-move decisions, 7.5 million of them refusals, plus deals, table state, scoring and winners. Of 47 deliberately broken builds, 45 failed the tests. The other two remove checks that only give a clearer message, because the arithmetic already refuses those moves.
