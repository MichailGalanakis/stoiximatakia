import { test } from 'node:test';
import { createRequire } from 'node:module';
import { engine as e, assert } from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const finite = 'kb6/p1p5/P1P5/p7/8/7P/P1P1PPPN/RB2K1NR w KQ - 0 1';
const larger = { maxPositions: 10000, maxExpanded: 10000, maxEdges: 100000 };
const copy = (value) => JSON.parse(JSON.stringify(value));

test('verified decisions derive live, static and full-graph verdicts without changing the existing validity API', () => {
  for (const [fen, certificates] of [
    ['7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', true],
    ['7k/8/8/8/8/8/8/K7 w - - 0 1', true],
    [finite, false],
  ]) {
    const result = e.solveMateReachability(fen, larger, certificates);
    assert.notEqual(result.status, 'unknown');
    const verified = e.verifyReachabilityDecision(fen, result.evidence, larger);
    assert.deepEqual(verified, {
      valid: true,
      verdict: result.status,
      root: e.positionKey(e.parseFen(fen)),
      engineVersion: e.ENGINE_VERSION,
      rulesVersion: e.RULES_VERSION,
    });
    assert.ok(Object.isFrozen(verified));
    assert.deepEqual(
      cjs.verifyReachabilityDecision(fen, result.evidence, larger),
      verified,
    );
    assert.deepEqual(
      e.verifyReachabilityEvidence(fen, result.evidence, larger),
      { valid: true },
    );
    assert.deepEqual(
      e.verifyReachabilityDecision(
        fen.replace(' 0 1', ' 4 8'),
        result.evidence,
        larger,
      ),
      verified,
    );
  }
});

test('changing getters and later mutation cannot change the verdict extracted from the verified snapshot', () => {
  const proof = e.solveMateReachability(finite, larger, false).evidence;
  let reads = 0;
  const mutable = {
    ...copy(proof),
    get kind() {
      return ++reads === 1 ? 'closed-movement-graph' : 'reachable-mate';
    },
  };
  const checked = e.verifyReachabilityDecision(finite, mutable, larger);
  assert.equal(checked.valid, true);
  assert.equal(checked.verdict, 'dead');
  assert.equal(reads, 1, 'verification detaches the source only once');
  assert.equal(
    mutable.kind,
    'reachable-mate',
    'caller input can now claim the opposite classification',
  );
  mutable.root = 'untrusted';
  mutable.nodes.length = 0;
  assert.equal(checked.verdict, 'dead');
  assert.equal(checked.root, proof.root);
  assert.throws(() => {
    checked.verdict = 'not-dead';
  }, TypeError);
  const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
  const live = copy(e.solveMateReachability(fen).evidence);
  const positive = e.verifyReachabilityDecision(fen, live);
  live.moves.length = 0;
  live.winner = live.winner === 'white' ? 'black' : 'white';
  assert.equal(positive.verdict, 'not-dead');
  assert.equal(e.verifyReachabilityDecision(fen, live).valid, false);
});

test('wrong version, root, turn, rights, legal en-passant and incomplete evidence produce no verdict', () => {
  const proof = e.solveMateReachability(finite, larger, false).evidence;
  for (const mutate of [
    (p) => {
      p.engineVersion = '0.2.0';
    },
    (p) => {
      p.rulesVersion = 'other';
    },
    (p) => {
      p.root = 'wrong';
    },
    (p) => {
      p.nodes[0].successors.pop();
    },
  ]) {
    const bad = copy(proof);
    mutate(bad);
    const checked = e.verifyReachabilityDecision(finite, bad, larger);
    assert.equal(checked.valid, false);
    assert.equal(checked.verdict, undefined);
    assert.ok(Object.isFrozen(checked));
  }
  for (const fen of [
    finite.replace(' w ', ' b '),
    finite.replace(' KQ ', ' Q '),
  ])
    assert.equal(e.verifyReachabilityDecision(fen, proof, larger).valid, false);
  const ep = 'kb6/p1p5/P1P5/5pP1/5P2/8/8/4K3 w - f6 0 1';
  const epProof = e.solveMateReachability(ep).evidence;
  assert.equal(
    e.verifyReachabilityDecision(ep.replace(' f6 ', ' - '), epProof).valid,
    false,
  );
  const unresolved = e.solveMateReachability(e.START_FEN, { maxPositions: 1 });
  assert.equal(unresolved.status, 'unknown');
  const checked = e.verifyReachabilityDecision(
    e.START_FEN,
    unresolved.evidence,
  );
  assert.equal(checked.valid, false);
  assert.equal(checked.verdict, undefined);
});
