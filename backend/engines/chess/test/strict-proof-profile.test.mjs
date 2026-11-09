import { test } from 'node:test';
import { createRequire } from 'node:module';
import { engine as e, assert, ok, players, move } from './helpers.mjs';

const require = createRequire(import.meta.url),
  cjs = require('../dist/cjs/index.js');
const fool = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
const specs = (line) =>
  line.map((m) => ({
    from: m.slice(0, 2),
    to: m.slice(2, 4),
    ...(m[4] ? { promotion: m[4] } : {}),
  }));
const proof = (engine, candidate, line = fool) => ({
  kind: 'reachable-mate',
  engineVersion: engine.ENGINE_VERSION,
  rulesVersion: engine.RULES_VERSION,
  root: candidate.root,
  winner: 'black',
  moves: specs(line),
});
function start(engine = e) {
  const candidate = ok(engine.prepareStrictGame({ players }));
  return ok(engine.finishStrictCandidate(candidate, proof(engine, candidate)));
}
function act(
  engine,
  state,
  action,
  line,
  actor = state.initial.players[state.turn],
) {
  const candidate = ok(
    engine.prepareStrictAction(state, actor, action, state.revision),
  );
  return ok(
    engine.finishStrictCandidate(
      candidate,
      candidate.needsEvidence ? proof(engine, candidate, line) : undefined,
    ),
  );
}

test('strict preparation returns no accepted state until exact candidate evidence is checked', () => {
  const candidate = ok(e.prepareStrictGame({ players }));
  assert.equal(candidate.needsEvidence, true);
  assert.equal(candidate.baseRevision, null);
  assert.equal(candidate.revision, 0);
  assert.ok(Object.isFrozen(candidate));
  assert.equal(candidate.state, undefined);
  assert.equal(e.finishStrictCandidate(candidate).error.code, 'PROOF_REQUIRED');
  assert.equal(
    e.finishStrictCandidate(candidate, null).error.code,
    'PROOF_REQUIRED',
  );
  assert.equal(
    e.finishStrictCandidate({ ...candidate }, proof(e, candidate)).error.code,
    'INVALID_ACTION',
  );
  const bad = proof(e, candidate);
  bad.root = bad.root.replace(' w ', ' b ');
  assert.equal(
    e.finishStrictCandidate(candidate, bad).error.code,
    'INVALID_PROOF',
  );
  const state = ok(e.finishStrictCandidate(candidate, proof(e, candidate)));
  assert.equal(state.engineVersion, e.STRICT_ENGINE_VERSION);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.rulesVersion, e.STRICT_RULES_VERSION);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].evidence.engineVersion, e.ENGINE_VERSION);
  assert.equal(state.phase, 'playing');
  assert.equal(state.revision, 0);
  assert.equal(e.restoreState(state).error.code, 'UNSUPPORTED_VERSION');
  assert.equal(
    e.restoreStrictState(ok(e.createGame({ players }))).error.code,
    'UNSUPPORTED_VERSION',
  );
});

test('physical moves each retain evidence while nonmove commands reuse the previous position decision', () => {
  for (const engine of [e, cjs]) {
    let state = start(engine);
    const decisions = state.decisions;
    state = act(engine, state, { type: 'offer-draw' });
    assert.equal(state.decisions, decisions);
    state = act(engine, state, { type: 'decline-draw' }, undefined, 'bob');
    assert.equal(state.decisions, decisions);
    for (let i = 0; i < fool.length; i++) {
      const candidate = ok(
        engine.prepareStrictAction(
          state,
          state.initial.players[state.turn],
          move(fool[i].slice(0, 2), fool[i].slice(2, 4)),
          state.revision,
        ),
      );
      assert.equal(candidate.needsEvidence, true);
      assert.equal(candidate.baseRevision, state.revision);
      const before = JSON.stringify(state);
      assert.equal(
        engine.finishStrictCandidate(candidate).error.code,
        'PROOF_REQUIRED',
      );
      const next = ok(
        engine.finishStrictCandidate(
          candidate,
          proof(engine, candidate, fool.slice(i + 1)),
        ),
      );
      assert.equal(JSON.stringify(state), before);
      assert.deepEqual(
        ok(
          engine.finishStrictCandidate(
            candidate,
            proof(engine, candidate, fool.slice(i + 1)),
          ),
        ),
        next,
      );
      state = next;
    }
    assert.equal(state.phase, 'ended');
    assert.equal(state.ply, 4);
    assert.equal(state.revision, 6);
    assert.equal(state.roundOutcome.reason, 'checkmate');
    assert.deepEqual(
      state.decisions.map((receipt) => receipt.revision),
      [0, 3, 4, 5, 6],
    );
    assert.deepEqual(
      ok(engine.restoreStrictState(JSON.stringify(state))),
      state,
    );
    assert.deepEqual(
      ok(engine.replayStrict(state.initial, state.history, state.decisions)),
      state,
    );
    const view = ok(
      engine.getStrictObservation(JSON.parse(JSON.stringify(state)), 'alice'),
    );
    assert.equal(view.rulesVersion, engine.STRICT_RULES_VERSION);
    assert.deepEqual(view.conformance, {
      clocks: false,
      automaticDeadPositionDetection: 'required-verified-evidence',
      unprovedContinuation: false,
      exhaustiveDeadPositionOracle: false,
    });
    assert.deepEqual(
      view.moves.map((m) => m.san),
      ['f3', 'e5', 'g4', 'Qh4#'],
    );
    assert.equal(view.decisions, undefined);
    assert.equal(view.legalActions.length, 0);
    assert.equal(
      engine.prepareStrictAction(
        state,
        'alice',
        move('e2', 'e4'),
        state.revision,
      ).error.code,
      'GAME_ENDED',
    );
  }
});

test('strict cold restoration and observation verify retained receipts without calling any search routine', () => {
  const scholar = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'];
  let checkedSource;
  {
    const initial = ok(cjs.prepareStrictGame({ players }));
    const initialProof = { ...proof(cjs, initial, scholar), winner: 'white' };
    checkedSource = ok(cjs.finishStrictCandidate(initial, initialProof));
    for (let i = 0; i < 6; i++) {
      const candidate = ok(
        cjs.prepareStrictAction(
          checkedSource,
          checkedSource.initial.players[checkedSource.turn],
          move(scholar[i].slice(0, 2), scholar[i].slice(2, 4)),
          checkedSource.revision,
        ),
      );
      checkedSource = ok(
        cjs.finishStrictCandidate(candidate, {
          ...proof(cjs, candidate, scholar.slice(i + 1)),
          winner: 'white',
        }),
      );
    }
  }
  const search = require('../dist/cjs/reachability.js'),
    saved = new Map();
  for (const name of [
    'solveMateReachability',
    'solveMateReachabilityExactly',
    'createMateReachabilitySearch',
    'findMateReachabilityWitness',
  ]) {
    saved.set(name, search[name]);
    search[name] = () => {
      throw Error('strict path attempted search');
    };
  }
  try {
    let state = start(cjs);
    state = act(cjs, state, move('f2', 'f3'), fool.slice(1));
    const restored = ok(cjs.restoreStrictState(JSON.stringify(state)));
    assert.deepEqual(restored, state);
    assert.deepEqual(
      ok(cjs.replayStrict(state.initial, state.history, state.decisions)),
      state,
    );
    assert.equal(
      ok(cjs.getStrictObservation(JSON.parse(JSON.stringify(state)), 'bob'))
        .turn,
      'black',
    );
    assert.equal(
      ok(
        cjs.prepareStrictAction(
          restored,
          'bob',
          move('e7', 'e5'),
          restored.revision,
        ),
      ).needsEvidence,
      true,
    );
    const checkingCandidate = ok(
      cjs.prepareStrictAction(
        JSON.stringify(checkedSource),
        'alice',
        move('h5', 'e5'),
        checkedSource.revision,
      ),
    );
    assert.equal(checkingCandidate.needsEvidence, true);
    assert.equal(
      new (require('chess.js').Chess)(checkingCandidate.fen).isCheck(),
      true,
    );
  } finally {
    for (const [name, value] of saved) search[name] = value;
  }
});

test('wrong actor, revision, action or proof cannot mutate strict source state', () => {
  const state = start(),
    before = JSON.stringify(state);
  for (const [actor, action, revision, code] of [
    ['outsider', move('f2', 'f3'), 0, 'UNKNOWN_PLAYER'],
    ['bob', move('f2', 'f3'), 0, 'NOT_YOUR_TURN'],
    ['alice', move('f2', 'f3'), 1, 'STALE_REVISION'],
    ['alice', { type: 'resign' }, 0, 'INVALID_ACTION'],
    ['alice', { type: 'adjudication' }, 0, 'INVALID_ACTION'],
  ])
    assert.equal(
      e.prepareStrictAction(state, actor, action, revision).error.code,
      code,
    );
  const candidate = ok(
    e.prepareStrictAction(state, 'alice', move('f2', 'f3'), 0),
  );
  const bad = proof(e, candidate, fool.slice(1));
  bad.engineVersion = e.STRICT_ENGINE_VERSION;
  assert.equal(
    e.finishStrictCandidate(candidate, bad).error.code,
    'INVALID_PROOF',
  );
  const changed = proof(e, candidate, fool.slice(1));
  changed.root = state.decisions[0].evidence.root;
  assert.equal(
    e.finishStrictCandidate(candidate, changed).error.code,
    'INVALID_PROOF',
  );
  const excessive = {
    ...proof(e, candidate, fool.slice(1)),
    padding: 'x'.repeat(16000001),
  };
  assert.equal(
    e.finishStrictCandidate(candidate, excessive).error.code,
    'RESOURCE_LIMIT',
  );
  assert.equal(JSON.stringify(state), before);
});

test('strict receipts are detached, immutable and mandatory during replay, including exact revision placement', () => {
  const candidate = ok(e.prepareStrictGame({ players })),
    evidence = proof(e, candidate);
  const state = ok(e.finishStrictCandidate(candidate, evidence));
  evidence.moves.length = 0;
  evidence.root = 'mutated';
  assert.equal(state.decisions[0].evidence.moves.length, 4);
  assert.ok(Object.isFrozen(state.decisions[0].evidence.moves));
  const copy = () => JSON.parse(JSON.stringify(state));
  for (const mutate of [
    (s) => {
      s.decisions = [];
    },
    (s) => {
      s.decisions[0].revision = 1;
    },
    (s) => {
      s.decisions.push(s.decisions[0]);
    },
    (s) => {
      s.decisions[0].evidence.root = 'other';
    },
    (s) => {
      s.phase = 'ended';
    },
    (s) => {
      s.engineVersion = e.ENGINE_VERSION;
    },
    (s) => {
      s.initial.mode = 'analysis';
    },
  ]) {
    const changed = copy();
    mutate(changed);
    assert.equal(e.restoreStrictState(changed).ok, false);
  }
  assert.equal(
    e.replayStrict(state.initial, state.history, []).error.code,
    'PROOF_REQUIRED',
  );
  const offered = ok(
    e.prepareStrictAction(state, 'alice', { type: 'offer-draw' }, 0),
  );
  assert.equal(offered.needsEvidence, false);
  assert.equal(
    e.finishStrictCandidate(offered, state.decisions[0].evidence).error.code,
    'INVALID_PROOF',
  );
  const next = ok(e.finishStrictCandidate(offered));
  assert.ok(
    ok(e.getStrictObservation(next, 'alice')).legalActions.every(
      (a) => a.type !== 'resign',
    ),
  );
});

const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
const cycleProofs = [
  ['e7e5', 'f3g1', 'b8c6', 'f2f3', 'd7d5', 'g2g4', 'd8h4'],
  ['f3g1', 'f6g8', ...fool],
  ['f6g8', ...fool],
  fool,
];
function cyclePlay(count) {
  let state = start();
  for (let i = 0; i < count; i++)
    state = act(
      e,
      state,
      move(cycle[i % 4].slice(0, 2), cycle[i % 4].slice(2, 4)),
      cycleProofs[i % 4],
    );
  return state;
}
test('strict evidence is movement-bound while fivefold and intended threefold remain history-authoritative', () => {
  const fifth = cyclePlay(16);
  assert.equal(fifth.roundOutcome.reason, 'fivefold-repetition');
  assert.equal(fifth.decisions.length, 17);
  assert.equal(fifth.ply, 16);
  assert.deepEqual(ok(e.restoreStrictState(JSON.stringify(fifth))), fifth);
  const before = cyclePlay(7),
    receipt = before.decisions,
    fen = before.fen;
  const claim = act(e, before, {
    type: 'claim-draw',
    reason: 'threefold-repetition',
    intendedMove: { from: 'f6', to: 'g8' },
  });
  assert.equal(claim.roundOutcome.reason, 'threefold-repetition');
  assert.equal(claim.ply, 7);
  assert.equal(claim.fen, fen);
  assert.equal(claim.decisions, receipt);
  assert.deepEqual(
    ok(e.replayStrict(claim.initial, claim.history, claim.decisions)),
    claim,
  );
});

test('an incorrect intended-move claim retains its forced move without creating hypothetical board evidence', () => {
  const initial = start(),
    receipts = initial.decisions;
  const claimed = act(e, initial, {
    type: 'claim-draw',
    reason: 'fifty-move',
    intendedMove: { from: 'f2', to: 'f3' },
  });
  assert.equal(claimed.ply, 0);
  assert.equal(claimed.decisions, receipts);
  assert.deepEqual(claimed.forcedMove, { from: 'f2', to: 'f3' });
  assert.equal(
    e.prepareStrictAction(claimed, 'alice', move('g2', 'g4'), claimed.revision)
      .error.code,
    'FORCED_MOVE',
  );
  const candidate = ok(
    e.prepareStrictAction(claimed, 'alice', move('f2', 'f3'), claimed.revision),
  );
  assert.equal(candidate.needsEvidence, true);
  assert.equal(e.finishStrictCandidate(candidate).error.code, 'PROOF_REQUIRED');
  const moved = ok(
    e.finishStrictCandidate(candidate, proof(e, candidate, fool.slice(1))),
  );
  assert.equal(moved.ply, 1);
  assert.equal(moved.forcedMove, null);
  assert.deepEqual(
    moved.decisions.map((receipt) => receipt.revision),
    [0, 2],
  );
  assert.deepEqual(ok(e.restoreStrictState(JSON.stringify(moved))), moved);
});
