import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';
import { engine as e, assert } from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const nodeProof = (expansion) => ({
  kind: 'closed-movement-graph',
  root: expansion.position,
  engineVersion: e.ENGINE_VERSION,
  rulesVersion: e.RULES_VERSION,
  nodes: [expansion.node],
});

test('deterministic one-position expansion separates mate from checker-compatible sufficient leaves', () => {
  const mate = e.expandReachabilityPosition('7k/6Q1/5K2/8/8/8/8/8 b - - 9 7');
  assert.equal(mate.kind, 'mate');
  assert.equal(mate.winner, 'white');
  assert.equal(mate.node, undefined);
  for (const fen of [
    '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
    '7k/8/8/8/8/8/8/K7 w - - 0 1',
    '3k1b2/2p1pBp1/KpP1P1P1/1P3B2/4B1B1/5B2/8/8 w - - 3 57',
  ]) {
    const result = e.expandReachabilityPosition(fen);
    assert.equal(result.kind, 'leaf');
    assert.deepEqual(result.node.successors, []);
    assert.equal(
      e.verifyReachabilityDecision(fen, nodeProof(result)).verdict,
      'dead',
    );
    assert.equal(result.fen, result.position + ' 0 1');
    assert.equal(result.kernelEngineVersion, e.ENGINE_VERSION);
    assert.equal(result.kernelRulesVersion, e.RULES_VERSION);
    assert.deepEqual(cjs.expandReachabilityPosition(fen), result);
  }
});

test('canonical complete successor sets and representative moves agree with chess.js for normal, castling, EP and promotion positions', () => {
  const cases = [
    e.START_FEN,
    'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2',
    '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
  ];
  for (const fen of cases) {
    const result = e.expandReachabilityPosition(fen),
      oracle = new Chess(fen),
      expected = new Set();
    assert.equal(result.kind, 'branch');
    for (const move of oracle.moves({ verbose: true })) {
      oracle.move(move);
      expected.add(oracle.fen().split(' ').slice(0, 4).join(' '));
      oracle.undo();
    }
    assert.deepEqual(result.node.successors, [...expected].sort());
    assert.deepEqual(
      result.successors.map((value) => value.position),
      result.node.successors,
    );
    for (const value of result.successors) {
      oracle.move(value.move);
      assert.equal(
        oracle.fen().split(' ').slice(0, 4).join(' '),
        value.position,
      );
      oracle.undo();
      assert.equal(value.fen, value.position + ' 0 1');
      assert.ok(Object.isFrozen(value.move));
    }
    assert.deepEqual(cjs.expandReachabilityPosition(fen), result);
    assert.ok(Object.isFrozen(result));
  }
  assert.equal(e.expandReachabilityPosition(e.START_FEN).successors.length, 20);
  assert.deepEqual(
    e.expandReachabilityPosition(
      e.START_FEN.replace(' 0 1', ' 1000000 1000000'),
    ),
    e.expandReachabilityPosition(e.START_FEN),
  );
  assert.deepEqual(
    new Set(
      e
        .expandReachabilityPosition(cases[3])
        .successors.filter((value) => value.move.promotion)
        .map((value) => value.move.promotion),
    ),
    new Set(['q', 'r', 'b', 'n']),
  );
  assert.ok(
    e
      .expandReachabilityPosition(cases[2])
      .successors.some(
        (value) => value.move.from === 'e5' && value.move.to === 'd6',
      ),
  );
  for (const to of ['g1', 'c1'])
    assert.ok(
      e
        .expandReachabilityPosition(cases[1])
        .successors.some(
          (value) => value.move.from === 'e1' && value.move.to === to,
        ),
    );
});

test('private builders can assemble a complete independently checked graph using only the public expansion helper', () => {
  const fen = 'kb6/p1p5/P1P5/p7/8/7P/P1P1PPPN/RB2K1NR w KQ - 0 1',
    queue = [fen],
    seen = new Set(),
    nodes = [];
  for (let index = 0; index < queue.length; index++) {
    const result = e.expandReachabilityPosition(queue[index]);
    if (seen.has(result.position)) continue;
    seen.add(result.position);
    assert.ok(seen.size < 10000, 'test fixture resource scope');
    assert.notEqual(result.kind, 'mate');
    nodes.push(result.node);
    if (result.kind === 'branch')
      for (const child of result.successors) queue.push(child.fen);
  }
  const proof = {
    kind: 'closed-movement-graph',
    root: e.positionKey(e.parseFen(fen)),
    engineVersion: e.ENGINE_VERSION,
    rulesVersion: e.RULES_VERSION,
    nodes,
  };
  assert.ok(nodes.length > 1);
  assert.equal(
    e.verifyReachabilityDecision(fen, proof, {
      maxPositions: 10000,
      maxExpanded: 10000,
      maxEdges: 100000,
    }).verdict,
    'dead',
  );
});
