import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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
async function checked(engine, candidate, line = fool, winner = 'black') {
  const header = JSON.stringify({
    format: engine.REACHABILITY_STREAM_FORMAT,
    kind: 'reachable-mate',
    engineVersion: engine.ENGINE_VERSION,
    rulesVersion: engine.RULES_VERSION,
    root: candidate.root,
    winner,
  });
  const body = specs(line).map((value) => JSON.stringify(value));
  async function* records() {
    yield* body;
  }
  const token = await engine.verifyStreamingReachability(
    candidate.fen,
    header,
    records(),
  );
  assert.equal(token.valid, true);
  const descriptor = {
    artifactId: createHash('sha256')
      .update(header + '\n' + body.join('\n'))
      .digest('hex'),
    root: candidate.root,
    kernelEngineVersion: engine.ENGINE_VERSION,
    kernelRulesVersion: engine.RULES_VERSION,
    format: engine.REACHABILITY_STREAM_FORMAT,
  };
  return {
    token,
    descriptor,
    binding: ok(engine.bindVerifiedArtifact(token, descriptor)),
  };
}
async function start(engine = e) {
  const candidate = ok(engine.prepareArtifactGame({ players })),
    proof = await checked(engine, candidate);
  return {
    state: ok(engine.finishArtifactCandidate(candidate, proof.binding)),
    bindings: [proof.binding],
    ...proof,
  };
}
async function act(
  engine,
  state,
  bindings,
  action,
  line,
  actor = state.initial.players[state.turn],
) {
  const candidate = ok(
    engine.prepareArtifactAction(
      state,
      actor,
      action,
      state.revision,
      bindings,
    ),
  );
  if (!candidate.needsEvidence)
    return { state: ok(engine.finishArtifactCandidate(candidate)), bindings };
  const proof = await checked(engine, candidate, line);
  return {
    state: ok(engine.finishArtifactCandidate(candidate, proof.binding)),
    bindings: [...bindings, proof.binding],
  };
}

test('only genuine same-worker stream decisions bind artifact transport descriptors', async () => {
  const candidate = ok(e.prepareArtifactGame({ players })),
    proof = await checked(e, candidate);
  assert.ok(Object.isFrozen(proof.binding));
  assert.equal(proof.binding.verdict, undefined);
  assert.equal(
    e.bindVerifiedArtifact({ ...proof.token }, proof.descriptor).error.code,
    'INVALID_PROOF',
  );
  assert.equal(
    cjs.bindVerifiedArtifact(proof.token, proof.descriptor).error.code,
    'INVALID_PROOF',
  );
  for (const mutate of [
    (d) => {
      d.artifactId = 'not-a-digest';
    },
    (d) => {
      d.artifactId = 'A'.repeat(64);
    },
    (d) => {
      d.root = d.root.replace(' w ', ' b ');
    },
    (d) => {
      d.kernelEngineVersion = 'old';
    },
    (d) => {
      d.kernelRulesVersion = 'old';
    },
    (d) => {
      d.format = 'manifest-format';
    },
    (d) => {
      d.verdict = 'dead';
    },
  ]) {
    const bad = { ...proof.descriptor };
    mutate(bad);
    assert.equal(
      e.bindVerifiedArtifact(proof.token, bad).error.code,
      'INVALID_PROOF',
    );
  }
  const mutable = { ...proof.descriptor },
    handle = ok(e.bindVerifiedArtifact(proof.token, mutable));
  mutable.artifactId = 'f'.repeat(64);
  assert.equal(handle.artifactId, proof.descriptor.artifactId);
});

test('artifact preparation requires a genuine exact-root handle and rejects cross-profile candidates', async () => {
  const candidate = ok(e.prepareArtifactGame({ players })),
    proof = await checked(e, candidate);
  assert.equal(candidate.schemaVersion, 3);
  assert.equal(candidate.engineVersion, e.ARTIFACT_ENGINE_VERSION);
  assert.equal(candidate.state, undefined);
  assert.ok(Object.isFrozen(candidate));
  assert.equal(
    e.finishArtifactCandidate(candidate).error.code,
    'PROOF_REQUIRED',
  );
  assert.equal(
    e.finishArtifactCandidate(candidate, { ...proof.binding }).error.code,
    'INVALID_PROOF',
  );
  assert.equal(
    e.finishArtifactCandidate({ ...candidate }, proof.binding).error.code,
    'INVALID_ACTION',
  );
  assert.equal(e.finishStrictCandidate(candidate).error.code, 'INVALID_ACTION');
  const old = ok(e.prepareStrictGame({ players }));
  assert.equal(
    e.finishArtifactCandidate(old, proof.binding).error.code,
    'INVALID_ACTION',
  );
  const state = ok(e.finishArtifactCandidate(candidate, proof.binding));
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.engineVersion, '0.4.0-strict.2');
  assert.equal(state.rulesVersion, e.ARTIFACT_RULES_VERSION);
  assert.deepEqual(
    Object.keys(state.decisions[0]).sort(),
    [
      'revision',
      'artifactId',
      'root',
      'kernelEngineVersion',
      'kernelRulesVersion',
      'format',
    ].sort(),
  );
  assert.equal(state.decisions[0].artifactId, proof.binding.artifactId);
  assert.equal(state.decisions[0].evidence, undefined);
  assert.equal(state.decisions[0].verdict, undefined);
  assert.equal(e.restoreStrictState(state).error.code, 'UNSUPPORTED_VERSION');
  assert.equal(e.restoreState(state).error.code, 'UNSUPPORTED_VERSION');
  assert.equal(
    e.restoreArtifactState(ok(e.createGame({ players })), [proof.binding]).error
      .code,
    'UNSUPPORTED_VERSION',
  );
  assert.equal(e.restoreArtifactState(state, []).error.code, 'PROOF_REQUIRED');
  const oldState = ok(
    e.finishStrictCandidate(old, {
      kind: 'reachable-mate',
      engineVersion: e.ENGINE_VERSION,
      rulesVersion: e.RULES_VERSION,
      root: old.root,
      winner: 'black',
      moves: specs(fool),
    }),
  );
  const relabelled = {
    ...oldState,
    schemaVersion: e.ARTIFACT_SCHEMA_VERSION,
    engineVersion: e.ARTIFACT_ENGINE_VERSION,
    rulesVersion: e.ARTIFACT_RULES_VERSION,
  };
  assert.equal(
    e.restoreArtifactState(relabelled, [proof.binding]).ok,
    false,
    'labels alone cannot migrate inline evidence into checked artifact refs',
  );
  assert.equal(
    e.getArtifactObservation(state, 'alice', []).error.code,
    'PROOF_REQUIRED',
  );
});

test('artifact move refs, unchanged-position decisions and zero-record terminal mate replay correctly', async () => {
  for (const engine of [e, cjs]) {
    let { state, bindings } = await start(engine);
    const rootRefs = state.decisions;
    ({ state, bindings } = await act(engine, state, bindings, {
      type: 'offer-draw',
    }));
    assert.deepEqual(state.decisions, rootRefs);
    ({ state, bindings } = await act(
      engine,
      state,
      bindings,
      { type: 'decline-draw' },
      undefined,
      'bob',
    ));
    for (let i = 0; i < fool.length; i++) {
      const candidate = ok(
        engine.prepareArtifactAction(
          state,
          state.initial.players[state.turn],
          move(fool[i].slice(0, 2), fool[i].slice(2, 4)),
          state.revision,
          bindings,
        ),
      );
      const proof = await checked(engine, candidate, fool.slice(i + 1));
      if (i === 3) assert.equal(proof.token.counts.records, '0');
      const before = JSON.stringify(state);
      const conflicting = ok(
        engine.bindVerifiedArtifact(proof.token, {
          ...proof.descriptor,
          artifactId: bindings[0].artifactId,
        }),
      );
      assert.equal(
        engine.finishArtifactCandidate(candidate, conflicting).error.code,
        'INVALID_PROOF',
        'a new root cannot reuse a prior artifact identity',
      );
      assert.equal(
        engine.finishArtifactCandidate(candidate, bindings[0]).error.code,
        'INVALID_PROOF',
      );
      state = ok(engine.finishArtifactCandidate(candidate, proof.binding));
      bindings = [...bindings, proof.binding];
      assert.notEqual(JSON.stringify(state), before);
      assert.equal(state.ply, i + 1);
    }
    assert.equal(state.phase, 'ended');
    assert.equal(state.roundOutcome.reason, 'checkmate');
    assert.equal(state.roundOutcome.winner, 'black');
    assert.deepEqual(
      state.decisions.map((ref) => ref.revision),
      [0, 3, 4, 5, 6],
    );
    assert.deepEqual(
      ok(engine.restoreArtifactState(JSON.stringify(state), bindings)),
      state,
    );
    assert.deepEqual(
      ok(
        engine.replayArtifact(
          state.initial,
          state.history,
          state.decisions,
          bindings,
        ),
      ),
      state,
    );
    const view = ok(
      engine.getArtifactObservation(
        JSON.parse(JSON.stringify(state)),
        'alice',
        bindings,
      ),
    );
    assert.equal(view.rulesVersion, engine.ARTIFACT_RULES_VERSION);
    assert.deepEqual(
      view.moves.map((entry) => entry.san),
      ['f3', 'e5', 'g4', 'Qh4#'],
    );
    assert.equal(view.decisions, undefined);
    assert.equal(view.conformance.unprovedContinuation, false);
    assert.equal(
      engine.prepareArtifactAction(
        state,
        'alice',
        move('e2', 'e4'),
        state.revision,
        bindings,
      ).error.code,
      'GAME_ENDED',
    );
  }
});

test('cold artifact replay and observation require every original checked binding and never call search', async () => {
  let { state, bindings } = await start(cjs);
  ({ state, bindings } = await act(
    cjs,
    state,
    bindings,
    move('f2', 'f3'),
    fool.slice(1),
  ));
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
      throw Error('artifact path attempted search');
    };
  }
  try {
    assert.deepEqual(
      ok(cjs.restoreArtifactState(JSON.stringify(state), bindings)),
      state,
    );
    assert.deepEqual(
      ok(
        cjs.replayArtifact(
          state.initial,
          state.history,
          state.decisions,
          bindings,
        ),
      ),
      state,
    );
    assert.equal(
      ok(cjs.getArtifactObservation(state, 'bob', bindings)).turn,
      'black',
    );
    assert.equal(
      ok(
        cjs.prepareArtifactAction(
          state,
          'bob',
          move('e7', 'e5'),
          state.revision,
          bindings,
        ),
      ).needsEvidence,
      true,
    );
    assert.equal(
      cjs.restoreArtifactState(state, bindings.slice(0, 1)).error.code,
      'PROOF_REQUIRED',
    );
    assert.equal(
      cjs.restoreArtifactState(
        state,
        bindings.map((b) => JSON.parse(JSON.stringify(b))),
      ).error.code,
      'INVALID_PROOF',
    );
  } finally {
    for (const [name, value] of saved) search[name] = value;
  }
});

test('wrong refs, duplicate receipts, missing handles, profile flags and conflicting artifact IDs cannot authorise state', async () => {
  const started = await start(),
    state = started.state,
    bindings = started.bindings;
  for (const mutate of [
    (s) => {
      s.decisions = [];
    },
    (s) => {
      s.decisions.push(s.decisions[0]);
    },
    (s) => {
      s.decisions[0].revision = 1;
    },
    (s) => {
      s.decisions[0].artifactId = 'f'.repeat(64);
    },
    (s) => {
      s.decisions[0].root = 'other';
    },
    (s) => {
      s.decisions[0].kernelEngineVersion = 'old';
    },
    (s) => {
      s.decisions[0].kernelRulesVersion = 'old';
    },
    (s) => {
      s.decisions[0].format = 'wrong';
    },
    (s) => {
      s.decisions[0].verdict = 'dead';
    },
    (s) => {
      s.phase = 'ended';
    },
    (s) => {
      s.engineVersion = e.STRICT_ENGINE_VERSION;
    },
  ]) {
    const bad = JSON.parse(JSON.stringify(state));
    mutate(bad);
    assert.equal(e.restoreArtifactState(bad, bindings).ok, false);
  }
  for (const [actor, action, rev, code] of [
    ['outsider', move('f2', 'f3'), 0, 'UNKNOWN_PLAYER'],
    ['bob', move('f2', 'f3'), 0, 'NOT_YOUR_TURN'],
    ['alice', move('f2', 'f3'), 1, 'STALE_REVISION'],
    ['alice', { type: 'resign' }, 0, 'INVALID_ACTION'],
    ['alice', { type: 'adjudication' }, 0, 'INVALID_ACTION'],
  ])
    assert.equal(
      e.prepareArtifactAction(state, actor, action, rev, bindings).error.code,
      code,
    );
  const candidate = ok(
      e.prepareArtifactAction(state, 'alice', move('f2', 'f3'), 0, bindings),
    ),
    other = await checked(e, candidate, fool.slice(1));
  const conflict = ok(
    e.bindVerifiedArtifact(other.token, {
      ...other.descriptor,
      artifactId: bindings[0].artifactId,
    }),
  );
  assert.equal(
    e.restoreArtifactState(state, [...bindings, conflict]).error.code,
    'INVALID_PROOF',
  );
});

test('history-based claims reuse compact refs and repeated movement roots reuse the same checked artifact', async () => {
  let { state, bindings } = await start();
  const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'],
    proofs = [
      ['e7e5', 'f3g1', 'b8c6', 'f2f3', 'd7d5', 'g2g4', 'd8h4'],
      ['f3g1', 'f6g8', ...fool],
      ['f6g8', ...fool],
      fool,
    ];
  let seventh;
  for (let i = 0; i < 16; i++) {
    ({ state, bindings } = await act(
      e,
      state,
      bindings,
      move(cycle[i % 4].slice(0, 2), cycle[i % 4].slice(2, 4)),
      proofs[i % 4],
    ));
    if (i === 6) seventh = { state, bindings };
  }
  assert.equal(state.roundOutcome.reason, 'fivefold-repetition');
  assert.equal(state.decisions.length, 17);
  assert.equal(new Set(state.decisions.map((ref) => ref.artifactId)).size, 4);
  assert.deepEqual(
    ok(e.restoreArtifactState(JSON.stringify(state), bindings)),
    state,
  );
  const claim = await act(e, seventh.state, seventh.bindings, {
    type: 'claim-draw',
    reason: 'threefold-repetition',
    intendedMove: { from: 'f6', to: 'g8' },
  });
  assert.equal(claim.state.roundOutcome.reason, 'threefold-repetition');
  assert.equal(claim.state.ply, 7);
  assert.deepEqual(claim.state.decisions, seventh.state.decisions);
  const initial = await start(),
    badClaim = await act(e, initial.state, initial.bindings, {
      type: 'claim-draw',
      reason: 'fifty-move',
      intendedMove: { from: 'f2', to: 'f3' },
    });
  assert.deepEqual(badClaim.state.forcedMove, { from: 'f2', to: 'f3' });
  assert.equal(badClaim.state.decisions.length, 1);
  assert.equal(
    e.prepareArtifactAction(
      badClaim.state,
      'alice',
      move('g2', 'g4'),
      badClaim.state.revision,
      badClaim.bindings,
    ).error.code,
    'FORCED_MOVE',
  );
});
