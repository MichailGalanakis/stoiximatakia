import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as engine from '../dist/esm/index.js';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
// These are allowed strings. JSON escaping expands each code unit sixfold;
// counting the raw participant-id lengths would miss the actual snapshot size.
const players = { white: '\ud800'.repeat(256), black: '\ud801'.repeat(256) };
const MAX_SNAPSHOT_CHARACTERS = 16_000_000; // Existing documented import bound.
const take = (result) => {
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : JSON.stringify(result.error),
  );
  return result.state ?? result.value;
};
const records = (count) =>
  Array.from({ length: count }, (_, index) => ({
    kind: 'player',
    playerId: index % 2 ? players.black : players.white,
    action: { type: index % 2 ? 'decline-draw' : 'offer-draw' },
  }));
const initial = take(engine.createGame({ players })).initial;
let nearLimit;
function boundaryState() {
  // No board moves or position history are fabricated. Every offer and decline
  // is a valid accepted command from the standard root, replayed in order.
  return (nearLimit ??= take(engine.replay(initial, records(9_997))));
}

test('escaped participant ids survive ordinary state serialization without normalization', () => {
  const root = take(engine.createGame({ players })),
    serialized = take(engine.serializeState(root));
  assert.ok(serialized.includes('\\ud800'));
  assert.deepEqual(take(engine.restoreState(serialized)), root);
  assert.deepEqual(take(cjs.restoreState(serialized)), root);
  assert.deepEqual(root.initial.players, players);
});

test('an accepted near-capacity history remains serializable, restorable and replayable', () => {
  const state = boundaryState(),
    serialized = take(engine.serializeState(state));
  assert.equal(state.revision, 9_997);
  assert.equal(state.phase, 'playing');
  assert.equal(state.ply, 0);
  assert.equal(state.positionHistory.length, 1);
  assert.equal(state.drawOffer.by, 'white');
  assert.ok(serialized.length <= MAX_SNAPSHOT_CHARACTERS);
  assert.ok(MAX_SNAPSHOT_CHARACTERS - serialized.length < 2_000);
  assert.deepEqual(take(engine.restoreState(serialized)), state);
  assert.deepEqual(take(engine.replay(state.initial, state.history)), state);
});

test('the next legal command cannot commit a snapshot larger than the restoration bound', () => {
  const state = boundaryState(),
    before = take(engine.serializeState(state));
  const action = { type: 'decline-draw' };
  assert.ok(
    take(engine.getLegalActions(state, players.black)).some(
      (candidate) => candidate.type === action.type,
    ),
  );
  const result = engine.applyAction(
    state,
    players.black,
    action,
    state.revision,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RESOURCE_LIMIT');
  assert.equal('state' in result, false);
  assert.equal('events' in result, false);
  assert.equal(take(engine.serializeState(state)), before);
  assert.equal(state.roundOutcome, null);
  assert.equal(state.matchOutcome, null);
  assert.equal(state.drawOffer.by, 'white');
  assert.equal(engine.getObservation(state, players.black).ok, true);
  assert.equal(
    engine.applyAction(state, players.black, action, state.revision - 1).error
      .code,
    'STALE_REVISION',
  );
});

test('low-level replay rejects an oversized accepted-record sequence without returning a partial state', () => {
  const history = records(10_000),
    first = history[0],
    last = history.at(-1);
  const result = engine.replay(initial, history);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RESOURCE_LIMIT');
  assert.equal('value' in result, false);
  assert.equal(history.length, 10_000);
  assert.equal(history[0], first);
  assert.equal(history.at(-1), last);
  assert.deepEqual(history.at(-1).action, { type: 'decline-draw' });
});

test('trusted finalization accepts exactly the existing JSON cap and atomically rejects one extra character', () => {
  const live = take(engine.replay(initial, records(9_988)));
  const pending = take(
    engine.applyAction(live, players.white, { type: 'resign' }, live.revision),
  );
  assert.equal(pending.phase, 'awaiting-adjudication'); // Existing resignation flow.
  const before = take(engine.serializeState(pending));
  // Black can genuinely mate this standard board (Fool's mate); the trusted
  // decision is separate from this independently checked witness and is not a
  // player-authorized adjudication endpoint.
  const witness = [
    { from: 'f2', to: 'f3' },
    { from: 'e7', to: 'e5' },
    { from: 'g2', to: 'g4' },
    { from: 'd8', to: 'h4' },
  ];
  engine.validateMateWitness(pending.fen, 'black', witness);
  const decision = (evidence) => ({
    type: 'resignation',
    opponentCanMate: true,
    authority: 'capacity-audit',
    evidence,
  });
  const short = take(
    engine.adjudicate(pending, decision('x'), pending.revision),
  );
  const extra =
    MAX_SNAPSHOT_CHARACTERS - take(engine.serializeState(short)).length;
  assert.ok(extra > 0);
  const evidence =
    'x' + '\ud802'.repeat(Math.floor(extra / 6)) + 'x'.repeat(extra % 6);
  assert.ok(evidence.length <= 4_096);
  const exact = take(
    engine.adjudicate(pending, decision(evidence), pending.revision),
  );
  const serialized = take(engine.serializeState(exact));
  assert.equal(serialized.length, MAX_SNAPSHOT_CHARACTERS);
  assert.equal(exact.roundOutcome.reason, 'resignation');
  assert.equal(exact.roundOutcome.winner, 'black');
  assert.deepEqual(take(engine.restoreState(serialized)), exact);
  assert.deepEqual(take(cjs.restoreState(serialized)), exact);
  const tooLarge = engine.adjudicate(
    pending,
    decision(evidence + 'x'),
    pending.revision,
  );
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error.code, 'RESOURCE_LIMIT');
  assert.equal('state' in tooLarge, false);
  assert.equal('events' in tooLarge, false);
  assert.equal(take(engine.serializeState(pending)), before);
  assert.equal(pending.roundOutcome, null);
  assert.equal(pending.matchOutcome, null);
});
