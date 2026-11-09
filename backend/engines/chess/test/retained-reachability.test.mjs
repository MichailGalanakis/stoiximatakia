import { test } from 'node:test';
import { createRequire } from 'node:module';
import { engine as e, assert } from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const finite = 'kb6/p1p5/P1P5/p7/8/7P/P1P1PPPN/RB2K1NR w KQ - 0 1';
const bounds = { maxPositions: 10000, maxExpanded: 10000, maxEdges: 100000 };

function finish(search, work) {
  let previous = null;
  for (let calls = 0; calls < 100000; calls++) {
    const result = search.advance(work);
    if (previous) {
      assert.ok(result.metrics.positions >= previous.metrics.positions);
      assert.ok(result.metrics.expanded >= previous.metrics.expanded);
      assert.ok(result.metrics.edges >= previous.metrics.edges);
      assert.ok(result.metrics.edges - previous.metrics.edges <= work);
    }
    if (result.status !== 'pending') return result;
    assert.equal(result.evidence, null);
    previous = result;
  }
  assert.fail('test graph did not finish within its independently known size');
}

test('one-edge work slices retain partial nodes and yield the same exact closed graph', () => {
  const search = e.createMateReachabilitySearch(finite, false);
  const result = finish(search, 1);
  const original = e.solveMateReachability(finite, bounds, false);
  assert.deepEqual(result, original);
  assert.equal(result.metrics.edges, 3557);
  assert.equal(result.metrics.positions, 1692);
  assert.deepEqual(
    e.verifyReachabilityEvidence(finite, result.evidence, bounds),
    {
      valid: true,
    },
  );
  assert.equal(search.advance(1), result, 'completed work is not repeated');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence.nodes));
  assert.ok(result.evidence.nodes.every(Object.isFrozen));
  assert.ok(
    result.evidence.nodes.every((node) => Object.isFrozen(node.successors)),
  );
});

test('retained exploration closes a cyclic graph beyond the old total position and expansion limits', () => {
  const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1';
  assert.equal(e.solveMateReachability(fen, {}, false).status, 'unknown');
  const result = finish(e.createMateReachabilitySearch(fen, false), 37);
  assert.equal(result.status, 'dead');
  assert.equal(result.metrics.positions, 7224);
  assert.equal(result.metrics.expanded, 7224);
  assert.equal(result.metrics.edges, 44352);
  assert.deepEqual(e.verifyReachabilityEvidence(fen, result.evidence, bounds), {
    valid: true,
  });
});

test('slice sizes and module formats do not affect the final proof or exceptional-right identity', () => {
  const expected = finish(e.createMateReachabilitySearch(finite), 11);
  assert.equal(expected.status, 'dead');
  for (const [engine, work] of [
    [e, 257],
    [cjs, 1],
    [cjs, 10000],
  ]) {
    const actual = finish(engine.createMateReachabilitySearch(finite), work);
    assert.deepEqual(actual, expected);
  }
  assert.equal(expected.evidence.root.split(' ')[2], 'KQ');
  assert.equal(
    e.verifyReachabilityEvidence(
      finite.replace(' KQ ', ' Q '),
      expected.evidence,
      bounds,
    ).valid,
    false,
  );
  const ep = 'kb6/p1p5/P1P5/5pP1/5P2/8/8/4K3 w - f6 0 1';
  const epProof = finish(e.createMateReachabilitySearch(ep, false), 1);
  assert.deepEqual(epProof, e.solveMateReachability(ep, bounds, false));
  assert.equal(epProof.evidence.root.split(' ')[3], 'f6');
  assert.equal(
    e.verifyReachabilityEvidence(
      ep.replace(' f6 ', ' - '),
      epProof.evidence,
      bounds,
    ).valid,
    false,
  );
});

test('terminal roots and reachable mate witnesses are checked independently', () => {
  for (const [fen, expected] of [
    ['7k/6Q1/5K2/8/8/8/8/8 b - - 0 1', 'not-dead'],
    ['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'dead'],
    ['7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', 'not-dead'],
    ['7k/8/2K5/8/8/8/6Q1/8 w - - 0 1', 'not-dead'],
  ]) {
    const result = finish(e.createMateReachabilitySearch(fen), 1);
    assert.equal(result.status, expected);
    if (fen.includes('2K5'))
      assert.ok(
        result.evidence.moves.length > 1,
        'mate line survives released ancestor boards',
      );
    assert.deepEqual(
      e.verifyReachabilityEvidence(fen, result.evidence, bounds),
      {
        valid: true,
      },
    );
  }
});

test('zero work and malformed quotas cannot erase progress or fabricate a result', () => {
  const search = e.createMateReachabilitySearch(e.START_FEN);
  const initial = search.advance(0);
  assert.equal(initial.status, 'pending');
  assert.equal(initial.metrics.edges, 0);
  assert.ok(Object.isFrozen(initial.metrics));
  assert.throws(() => {
    initial.metrics.edges = 100;
  }, TypeError);
  for (const quota of [-1, 0.5, NaN, 2000001]) {
    assert.throws(() => search.advance(quota));
    assert.deepEqual(search.advance(0), initial);
  }
  const advanced = search.advance(3);
  assert.equal(advanced.status, 'pending');
  assert.equal(advanced.metrics.edges, 3);
  assert.equal(initial.metrics.edges, 0, 'earlier progress is detached');
  assert.deepEqual(search.advance(0), advanced);
});

test('a difficult live root keeps inconclusive analysis separate from chess outcomes', () => {
  // CHA-Solver issue #48: a live position, not an expected automatic draw.
  const fen = '1Bb5/1p6/pPp3k1/2Pp3p/P2PpBpP/4P1P1/5K2/8 w - - 0 1';
  const search = e.createMateReachabilitySearch(fen);
  const first = search.advance(128);
  const second = search.advance(128);
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
  assert.equal(first.evidence, null);
  assert.equal(second.evidence, null);
  assert.equal(first.metrics.edges, 128);
  assert.equal(second.metrics.edges, 256);
  const state = e.createAnalysisGame({
    players: { white: 'w', black: 'b' },
    fen,
  });
  assert.equal(state.ok, true);
  assert.equal(state.state.phase, 'playing');
  assert.equal(state.state.matchOutcome, null);
});

test('guided search returns checked legal evidence from ordinary roots without inventing an answer at a cutoff', () => {
  const middlegame =
    'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  for (const fen of [e.START_FEN, middlegame]) {
    const result = e.findMateReachabilityWitness(fen);
    assert.equal(result.status, 'not-dead');
    assert.ok(result.evidence.moves.length > 0);
    assert.deepEqual(e.verifyReachabilityEvidence(fen, result.evidence), {
      valid: true,
    });
    assert.deepEqual(cjs.findMateReachabilityWitness(fen), result);
    const short = e.findMateReachabilityWitness(fen, { maxNodes: 1 });
    assert.deepEqual(short, { status: 'unknown', evidence: null, visited: 1 });
  }
  for (const options of [
    { maxNodes: -1 },
    { maxPlies: 257 },
    { randomState: -1 },
  ])
    assert.throws(() => e.findMateReachabilityWitness(e.START_FEN, options));
});

test('the analysis-only exact driver returns only a witness or full closure', () => {
  const live = e.solveMateReachabilityExactly(e.START_FEN);
  assert.equal(live.status, 'not-dead');
  assert.deepEqual(e.verifyReachabilityEvidence(e.START_FEN, live.evidence), {
    valid: true,
  });
  const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1';
  const dead = e.solveMateReachabilityExactly(fen, false);
  assert.equal(dead.status, 'dead');
  assert.equal(dead.evidence.nodes.length, 7224);
  assert.deepEqual(e.verifyReachabilityEvidence(fen, dead.evidence, bounds), {
    valid: true,
  });
  const terminal = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1';
  assert.deepEqual(e.solveMateReachabilityExactly(terminal).evidence.moves, []);
});
