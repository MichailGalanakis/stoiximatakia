import { test } from 'node:test';
import {
  engine as e,
  assert,
  ok,
  start,
  setup,
  move,
  play,
  sequence,
  rejected,
  cycle,
  players,
} from './helpers.mjs';
const clone = (value) => JSON.parse(JSON.stringify(value));

test('a snapshot resumes with its repetition history, not just its visible board', () => {
  const state = sequence(start(), [...cycle, ...cycle.slice(0, 3)]);
  const json = ok(e.serializeState(state)),
    restored = ok(e.restoreState(json));
  assert.deepEqual(restored, state);
  const next = play(restored, move('f6', 'g8'));
  assert.ok(
    ok(e.getDrawClaims(next, 'alice')).current.includes('threefold-repetition'),
  );
});
test('a snapshot retains a pending draw offer and binding intended move', () => {
  const state = play(sequence(start(), ['e2e4', 'e7e5']), {
    type: 'claim-draw',
    reason: 'threefold-repetition',
    intendedMove: { from: 'g1', to: 'f3' },
  });
  const restored = ok(e.restoreState(ok(e.serializeState(state))));
  assert.deepEqual(restored, state);
  rejected(restored, move('b1', 'c3'), 'FORCED_MOVE');
  assert.equal(
    play(restored, { type: 'accept-draw' }, 'bob').roundOutcome.reason,
    'draw-agreement',
  );
});
test('event replay exactly reproduces a normal finished game', () => {
  const state = sequence(start(), ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(e.restoreState(clone(state))), state);
});
test('serialized object key order is irrelevant', () => {
  const state = sequence(start(), ['d2d4', 'd7d5']);
  const reorder = (value) =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([k, v]) => [k, reorder(v)]),
          )
        : value;
  assert.deepEqual(ok(e.restoreState(reorder(clone(state)))), state);
});
for (const [name, mutate] of [
  [
    'FEN',
    (x) => {
      x.fen = e.START_FEN;
    },
  ],
  [
    'side to move',
    (x) => {
      x.turn = 'black';
    },
  ],
  [
    'ply counter',
    (x) => {
      x.ply = 999;
    },
  ],
  [
    'revision counter',
    (x) => {
      x.revision++;
    },
  ],
  [
    'past repetition identity',
    (x) => {
      x.positionHistory[0] = x.positionHistory.at(-1);
    },
  ],
  [
    'missing repetition history',
    (x) => {
      x.positionHistory = [];
    },
  ],
  [
    'forged castling rights',
    (x) => {
      x.fen = x.fen.replace('KQkq', '-');
    },
  ],
  [
    'forged clock',
    (x) => {
      const f = x.fen.split(' ');
      f[4] = '100';
      x.fen = f.join(' ');
    },
  ],
  [
    'forged phase',
    (x) => {
      x.phase = 'ended';
    },
  ],
  [
    'forged draw offer',
    (x) => {
      x.drawOffer = { by: 'black', atRevision: 2 };
    },
  ],
  [
    'forged compulsory move',
    (x) => {
      x.forcedMove = { from: 'e4', to: 'e5' };
    },
  ],
  [
    'forged per-player move counter',
    (x) => {
      x.movesByColor.white = 0;
    },
  ],
  [
    'missing action record',
    (x) => {
      x.history.pop();
    },
  ],
  [
    'forged actor',
    (x) => {
      x.history[0].playerId = 'bob';
    },
  ],
  [
    'illegal logged move',
    (x) => {
      x.history[0].action.to = 'e5';
    },
  ],
  [
    'unexpected metadata',
    (x) => {
      x.creditBalance = 100;
    },
  ],
])
  test(`rejects snapshot corruption: ${name}`, () => {
    const state = clone(sequence(start(), ['e2e4', 'e7e5']));
    mutate(state);
    assert.equal(e.validateState(state).valid, false);
    assert.equal(e.restoreState(state).ok, false);
    assert.equal(e.applyAction(state, 'alice', move('g1', 'f3')).ok, false);
  });
for (const field of ['schemaVersion', 'engineVersion', 'rulesVersion'])
  test(`rejects unrecognized ${field} without silent migration`, () => {
    const state = clone(start());
    state[field] = 'future';
    const result = e.restoreState(state);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'UNSUPPORTED_VERSION');
  });
test('state and nested objects are frozen, including returned observations', () => {
  const state = start();
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.initial.players), true);
  assert.throws(() => {
    state.fen = 'bad';
  }, TypeError);
  assert.throws(() => {
    state.history.push({});
  }, TypeError);
  const observation = ok(e.getObservation(state, 'alice'));
  assert.throws(() => {
    observation.legalActions[0].from = 'z9';
  }, TypeError);
  assert.equal(state.fen, e.START_FEN);
});
test('each revision must be checked against the server state; a duplicate command is rejected', () => {
  const state = start(),
    next = play(state, move('e2', 'e4'));
  rejected(next, move('e7', 'e5'), 'STALE_REVISION', 'bob', state.revision);
  rejected(next, move('e7', 'e5'), 'STALE_REVISION', 'bob', -1);
});
test('malformed JSON, non-objects and cycles are rejected rather than thrown to the caller', () => {
  for (const value of ['{', 'null', [], null, 7, undefined])
    assert.equal(e.restoreState(value).ok, false);
  const state = clone(start());
  state.cycle = state;
  assert.equal(e.restoreState(state).ok, false);
});
test('FEN alone is not accepted as a resumable game state', () => {
  assert.equal(e.restoreState(e.START_FEN).ok, false);
  assert.equal(
    e.applyAction({ fen: e.START_FEN }, 'alice', move('e2', 'e4')).ok,
    false,
  );
});
test('an analysis FEN is labelled and starts with one known repetition occurrence only', () => {
  const state = setup('4k3/8/8/8/8/8/8/R3K3 w - - 30 44');
  assert.equal(state.positionHistory.length, 1);
  assert.equal(state.ply, 0);
  assert.equal(ok(e.getObservation(state, 'alice')).analysisRoot, true);
  assert.deepEqual(ok(e.getDrawClaims(state, 'alice')).current, []);
});
test('standard creation cannot silently select a custom FEN, clocks, colors or variants', () => {
  for (const config of [
    { players, fen: e.START_FEN },
    { players, timeControl: '5+3' },
    { players, variant: 'chess960' },
    { players: ['alice', 'bob'] },
    { players: { white: 'alice', black: 'alice' } },
    { players: { white: '', black: 'bob' } },
    { players: { white: 'alice', black: 'bob', third: 'eve' } },
  ]) {
    const result = e.createGame(config);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_CONFIG');
  }
});
test('unknown action fields and malformed scalar values are rejected', () => {
  for (const action of [
    null,
    [],
    1,
    {},
    { type: 'move', from: 'E2', to: 'e4' },
    { type: 'move', from: 'e2', to: 'e9' },
    { type: 'move', from: 'e2', to: 'e4', playerId: 'bob' },
    { type: 'move', from: 'e2', to: 'e4', offerDraw: 'true' },
    { type: 'move', from: 'e2', to: 'e4', promotion: null },
    { type: 'claim-draw', reason: 'insufficient-material' },
    { type: 'offer-draw', secret: 1 },
  ])
    rejected(start(), action, 'INVALID_ACTION');
  rejected(start(), move('e2', 'e2'), 'ILLEGAL_MOVE');
});
test('spectator views contain no actions and unknown viewers are not silently spectators', () => {
  const state = start();
  assert.deepEqual(ok(e.getObservation(state, null)).legalActions, []);
  assert.equal(
    e.getObservation(state, 'intruder').error.code,
    'UNKNOWN_PLAYER',
  );
  assert.equal(
    e.getLegalActions(state, 'intruder').error.code,
    'UNKNOWN_PLAYER',
  );
  assert.equal(e.getDrawClaims(state, 'intruder').error.code, 'UNKNOWN_PLAYER');
});
test('observations expose only chess state, not the full internal replay record', () => {
  const state = play(start(), { type: 'offer-draw' });
  const observation = ok(e.getObservation(state, 'alice'));
  for (const field of [
    'history',
    'initial',
    'positionHistory',
    'randomState',
    'seed',
    'evidence',
    'engineVersion',
  ])
    assert.equal(field in observation, false);
  assert.deepEqual(observation.players, players);
  assert.equal(observation.drawOffer.by, 'white');
});
test('analysis FEN structural and local-legality checks reject malformed/unplayable roots', () => {
  const invalid = [
    '8/8/8/8/8/8/8/8 w - - 0 1', // no kings
    '4k3/8/8/8/8/8/4K3/4K3 w - - 0 1', // two white kings
    '4k3/8/8/8/8/8/4K3/8 x - - 0 1',
    '4k3/8/8/8/8/8/8/4K3 w KK - 0 1',
    '4k3/8/8/8/8/8/8/4K3 w K - 0 1', // absent rook
    '4k3/8/8/8/8/8/8/4K3 w - e6 0 1', // absent last-moved pawn
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 1 2', // inconsistent counter
    '4k3/8/8/3pP3/8/8/8/4K3 w - d3 0 2',
    '4k3/8/8/8/8/8/4K3/8 w - - -1 1',
    '4k3/8/8/8/8/8/4K3/8 w - - 0 0',
    '4k3/8/8/8/8/8/4K3/8 w - - 0',
    '4k3/8/8/8/8/8/4K3/8 w - - 0 1 extra',
    '4k3/8/8/8/8/8/44/4K3 w - - 0 1', // adjacent digits
    '4k3/9/8/8/8/8/8/4K3 w - - 0 1',
    '4k3/8/8/8/8/8/8/P3K3 w - - 0 1', // pawn on rank 1
    '4k3/8/8/8/8/8/4k3/4K3 w - - 0 1',
    '8/8/8/8/8/4k3/4K3/8 w - - 0 1', // adjacent kings
    '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1', // non-moving king in check
    '4k3/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1', // nine white pawns
    '4k3/8/8/8/8/8/PPPPPPPP/QQ2K3 w - - 0 1', // extra queen with all eight pawns
  ];
  for (const fen of invalid) {
    const result = e.createAnalysisGame({ players, fen });
    assert.equal(result.ok, false, fen);
    assert.equal(result.error.code, 'INVALID_FEN', fen);
  }
});
test('FEN roundtrip normalizes castling order but never invents rights', () => {
  const p = e.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w qkQK - 0 1');
  assert.equal(e.toFen(p).split(' ')[2], 'KQkq');
  assert.equal(
    e.toFen(e.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1')).split(' ')[2],
    '-',
  );
});
test('an invalid replay never returns a partial successful state', () => {
  const state = start();
  assert.equal(
    e.replay(state.initial, [
      { kind: 'player', playerId: 'bob', action: move('e7', 'e5') },
    ]).ok,
    false,
  );
  assert.equal(e.replay(state.initial, [{ kind: 'nonsense' }]).ok, false);
});
