# Xeri rules engine

Headless two-player Xeri to a 151-point match. It follows the same shape as `engines/chess/`: immutable JSON state, deterministic transitions, replay, per-viewer observations and legal-action bots. No engine is registered with the live table runtime yet.

From this folder's repository root, run `npm ci`, then `npm --prefix engines/xeri run check`. The check builds ESM and CommonJS, checks consumer types and runs the tests. It is not part of root `npm run check` yet.

## Rules

The rules come from section 7 of the supplied seven-game rulebook, with the designer's in-game rules (`card-rules.js`, `cards-fishing.js`, `fishing-score.js`) settling what the docs require to be preserved. In play: six cards each and a four-card pile, capture on the top rank or with a Jack, 10-point xeri, 20-point Jack-on-Jack xeri, last capturer collects leftovers without a xeri, and 25 ordinary points per round or 22 at 26-26.

| Point                         | This engine                                                                                                                                           | Source                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Both reach 151 in one round   | Higher total wins. An exact tie plays another round at the same target. Owner confirmed this over rulebook 7.5's extension to 251 on 1 November 2026. | In-game rules text and `recordRound`             |
| First dealer                  | Drawn from the secret seed, so neither seat has a fixed advantage.                                                                                    | Not specified; the reference is a solo game      |
| Dealer after a complete round | Alternates, and the non-dealer starts.                                                                                                                | Rulebook 7.1                                     |
| Next round                    | A completed nonterminal round stays at `round-end` with its scores visible until an authenticated participant submits `{type:"next"}`.                | Existing reference “Επόμενη διανομή” interaction |
| Blocked layout                | A top Jack or equal top two cards reshuffles the four table cards into the undealt stock. Hands stay.                                                 | Rulebook 7.1                                     |
| Four players                  | Not implemented. The table catalog gives Xeri two seats.                                                                                              | `docs/multiplayer-tables.md`                     |

## Integration boundary

The backend owns authentication, seat binding, transactions, revision control, settlement and forfeits. A platform forfeit stays outside the engine, as with chess. The engine has no clocks, draws or cancellation: a match always ends with one winner. `ply` is nonzero once any card has been accepted, which is the marker the no-cancellation rule needs.

Pass `players` in seat order and a `seed` of 64 lowercase hex characters from a CSPRNG, such as `randomBytes(32).toString('hex')`. The seed decides every hidden card, so it must stay private. SHA-256 in counter mode turns it into shuffles, which keeps replay exact without a stored deck.

Authoritative state contains the seed, both hands and the stock. It must never reach a client. Send players `getObservation(state, playerId)` only. Every event is safe to send to both players.

An observation holds the viewer's hand, the full table pile, public counts for the other hand, stock and captured piles, xeri marks and round results. The pile is public because every card in it was played face up, and the reference shows it too. Captured piles are counts because rulebook 7.2 keeps them face down until scoring.

`createAnalysisGame` scripts decks and opening scores for tests. A restored standard game refuses scripted decks, opening scores or a chosen dealer, so an analysis setup cannot pass as a fair game.

Version 0.2.0 (schema 2, rules v2) preserves the frontend round-result screen. Either seated participant may submit `{type:"next"}` only at `round-end`; server revision/operation checks serialize competing requests. The control adds a history record and advances `revision` without advancing `ply` or scoring again. It deals the next round with the existing deterministic shuffle and alternating dealer. Card plays remain blocked at the result screen, and a terminal match rejects the control. No clock, implicit timeout or extra ready step was added. Snapshots from the former automatic-round version require that original engine; do not relabel them.

Snapshots replay from `initial` and `history` on restore. A tampered hand, stock, score or result is rejected. Snapshots require their exact engine, rules and schema versions.

## Validation

The 60 tests cover the rulebook sections and the frontend round-control boundary. Historical v0.1.0 one-off checks on 1 November 2026 are not part of the suite, because `reference/` is local; they predate the explicit round-control lifecycle. Lockstep play against the designer's `cards-fishing.js` matched on all 5,000 matches and 2,335,008 plays, covering deals, turns, table, scoring, cumulative totals and winners. All 33 deliberately broken builds were caught, one by hanging the run. That comparison checks the engine against the reference, so it proves agreement with the in-game rules, not with rulebook 7.5.
