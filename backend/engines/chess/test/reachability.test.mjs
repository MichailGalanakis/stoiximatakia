import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { legalBoardMoves, advance } from '../dist/esm/position.js';
import {
  engine as e,
  assert,
  ok,
  players,
  rejected,
  setup,
  move,
} from './helpers.mjs';

const fen = 'kb6/p1p5/P1P5/p7/8/7P/P1P1PPPN/RB2K1NR w KQ - 0 1';
const larger = { maxPositions: 4096, maxExpanded: 4096, maxEdges: 8192 };
const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const clone = (value) => JSON.parse(JSON.stringify(value));

test('mutable accessors cannot change proof edges between verification and traversal', () => {
  const p = e.parseFen(e.START_FEN);
  const successors = [
    ...new Set(legalBoardMoves(p).map((m) => e.positionKey(advance(p, m)))),
  ].sort();
  let reads = 0;
  const node = {
    position: e.positionKey(p),
    leaf: null,
    get successors() {
      return ++reads <= successors.length + 3 ? successors : [];
    },
  };
  const forged = {
    kind: 'closed-movement-graph',
    engineVersion: e.ENGINE_VERSION,
    rulesVersion: e.RULES_VERSION,
    root: node.position,
    nodes: [node],
  };
  assert.equal(e.verifyReachabilityEvidence(e.START_FEN, forged).valid, false);
  assert.equal(reads, 1, 'take a stable data snapshot before checking');
  assert.equal(
    e.verifyReachabilityEvidence(fen, {
      ...forged,
      nodes: 'x'.repeat(16_000_001),
    }).valid,
    false,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(e.verifyReachabilityEvidence(fen, cyclic).valid, false);
});

test('authentic v0.1.6 games retain their original engine instead of silently relabelling history', () => {
  for (const name of ['root', 'next', 'standard']) {
    const original = readFileSync(
      new URL(`./legacy/v0.1.6-${name}.json`, import.meta.url),
      'utf8',
    );
    const snapshot = JSON.parse(original);
    assert.equal(snapshot.engineVersion, '0.1.6');
    assert.equal(e.restoreState(original).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(cjs.restoreState(original).error.code, 'UNSUPPORTED_VERSION');
    if (name === 'root') assert.equal(snapshot.phase, 'playing');
    if (name === 'next') assert.equal(snapshot.ply, 1);
    assert.equal(
      JSON.stringify(snapshot),
      JSON.stringify(JSON.parse(original)),
    );
  }
});

test('terminal frontier accounting resolves the current miss without a larger branch budget', () => {
  const proof = e.solveMateReachability(fen);
  assert.equal(proof.status, 'dead');
  assert.ok(proof.metrics.expanded < 256);
  assert.ok(
    proof.metrics.positions > 256,
    'terminal states must still be counted in the memory limit',
  );
  assert.equal(
    proof.metrics.positions,
    proof.metrics.expanded +
      proof.metrics.terminalLeaves +
      proof.metrics.certifiedLeaves,
  );
  assert.deepEqual(e.verifyReachabilityEvidence(fen, proof.evidence), {
    valid: true,
  });
  assert.deepEqual(cjs.solveMateReachability(fen), proof);
  assert.deepEqual(cjs.verifyReachabilityEvidence(fen, proof.evidence), {
    valid: true,
  });
  const state = setup(fen);
  assert.equal(state.phase, 'ended');
  assert.equal(state.matchOutcome.gameReason, 'dead-position-proven');
  assert.equal(state.revision, 0);
  assert.equal(state.ply, 0);
  assert.equal(state.fen, fen);
  assert.equal(state.positionHistory[0].split(' ')[2], 'KQ');
  rejected(state, move('c2', 'c4'), 'GAME_ENDED');
  assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(cjs.restoreState(JSON.stringify(state))), state);
  for (const viewer of [players.white, players.black, null])
    assert.deepEqual(ok(e.getObservation(state, viewer)).legalActions, []);
});

test('full unpruned graph is independently rechecked with exact closure and no certificates', () => {
  const proof = e.solveMateReachability(fen, larger, false);
  assert.equal(proof.status, 'dead');
  assert.equal(proof.metrics.positions, 1692);
  assert.equal(proof.metrics.edges, 3557);
  assert.equal(proof.metrics.terminalLeaves, 1335);
  assert.equal(proof.metrics.certifiedLeaves, 0);
  assert.deepEqual(
    e.verifyReachabilityEvidence(fen, clone(proof.evidence), larger),
    { valid: true },
  );
});

test('every work or memory cutoff returns unknown without partial evidence', () => {
  for (const limits of [
    { maxPositions: 1 },
    { maxExpanded: 0 },
    { maxEdges: 0 },
  ]) {
    const result = e.solveMateReachability(fen, limits);
    assert.equal(result.status, 'unknown');
    assert.equal(result.evidence, null);
  }
  for (const limits of [
    { maxPositions: -1 },
    { maxEdges: NaN },
    { maxExpanded: 0.5 },
    { maxPositions: 100001 },
  ]) {
    assert.throws(() => e.solveMateReachability(fen, limits));
  }
  const state = ok(e.createGame({ players }));
  assert.equal(state.phase, 'playing');
  assert.equal(state.matchOutcome, null);
  assert.equal(
    e.solveMateReachability(state.fen, { maxPositions: 1 }).status,
    'unknown',
  );
});

test('proof verifier rejects missing edges/nodes, forged leaves, extra nodes and version/root changes', () => {
  const proof = e.solveMateReachability(fen, larger, false).evidence;
  const cases = [
    (p) => {
      p.nodes[0].successors.pop();
    },
    (p) => {
      p.nodes.pop();
    },
    (p) => {
      p.nodes[0].leaf = 'stalemate';
      p.nodes[0].successors = [];
    },
    (p) => {
      p.nodes.push(p.nodes[0]);
    },
    (p) => {
      p.engineVersion = 'untrusted';
    },
    (p) => {
      p.rulesVersion = 'other-rules';
    },
    (p) => {
      p.root = e.positionKey(e.parseFen(e.START_FEN));
    },
    (p) => {
      p.nodes[0].successors.reverse();
    },
  ];
  for (const mutate of cases) {
    const bad = clone(proof);
    mutate(bad);
    assert.equal(e.verifyReachabilityEvidence(fen, bad, larger).valid, false);
  }
  assert.equal(
    e.verifyReachabilityEvidence(fen.replace(' KQ ', ' Q '), proof, larger)
      .valid,
    false,
  );
  for (const value of [
    null,
    {},
    [],
    { kind: 'closed-movement-graph', nodes: [] },
  ])
    assert.equal(e.verifyReachabilityEvidence(fen, value).valid, false);
});

test('a reachable mate produces a checked legal line rather than a draw', () => {
  const live = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
  const result = e.solveMateReachability(live);
  assert.equal(result.status, 'not-dead');
  assert.equal(result.evidence.winner, 'white');
  assert.deepEqual(e.verifyReachabilityEvidence(live, result.evidence), {
    valid: true,
  });
  assert.equal(
    e.verifyReachabilityEvidence(live, { ...result.evidence, winner: 'black' })
      .valid,
    false,
  );
  assert.equal(
    e.verifyReachabilityEvidence(live, { ...result.evidence, moves: [] }).valid,
    false,
  );
  assert.equal(setup(live).phase, 'playing');
});

test('actual checkmate precedes dead certificates, and stalemate needs no expansion', () => {
  const mate = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1';
  const won = e.solveMateReachability(mate, { maxExpanded: 0 });
  assert.equal(won.status, 'not-dead');
  assert.deepEqual(won.evidence.moves, []);
  assert.deepEqual(e.verifyReachabilityEvidence(mate, won.evidence), {
    valid: true,
  });
  const stalemate = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
  const drawn = e.solveMateReachability(stalemate, {
    maxExpanded: 0,
    maxEdges: 0,
  });
  assert.equal(drawn.status, 'dead');
  assert.deepEqual(
    e.verifyReachabilityEvidence(stalemate, drawn.evidence, {
      maxExpanded: 0,
      maxEdges: 0,
    }),
    { valid: true },
  );
});

test('cycles are handled by graph closure; an unfinished cycle never proves a draw', () => {
  const cycle = '7k/8/8/8/8/8/8/K7 w - - 0 1';
  assert.equal(
    e.solveMateReachability(cycle, { maxPositions: 32 }, false).status,
    'unknown',
  );
  const bounds = { maxPositions: 10000, maxExpanded: 10000, maxEdges: 100000 };
  const closed = e.solveMateReachability(cycle, bounds, false);
  assert.equal(closed.status, 'dead');
  assert.deepEqual(
    e.verifyReachabilityEvidence(cycle, closed.evidence, bounds),
    { valid: true },
  );
  const extra = clone(closed.evidence);
  extra.nodes.push({
    position: '8/7k/8/8/8/8/8/K7 w - -',
    leaf: 'material',
    successors: [],
  });
  assert.equal(e.verifyReachabilityEvidence(cycle, extra, bounds).valid, false);
});
