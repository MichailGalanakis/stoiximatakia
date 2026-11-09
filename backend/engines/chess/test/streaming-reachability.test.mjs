import { test } from 'node:test';
import { createRequire } from 'node:module';
import { engine as e, assert } from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const finite = 'kb6/p1p5/P1P5/p7/8/7P/P1P1PPPN/RB2K1NR w KQ - 0 1';
const bounds = { maxPositions: 10000, maxExpanded: 10000, maxEdges: 100000 };
const clone = (value) => JSON.parse(JSON.stringify(value));
function header(evidence) {
  const { nodes, moves, ...binding } = evidence;
  void nodes;
  void moves;
  return JSON.stringify({ format: e.REACHABILITY_STREAM_FORMAT, ...binding });
}
async function* records(values) {
  for (const value of values) yield JSON.stringify(value);
}
class RamPrivateWorkset {
  started = false;
  nodes = new Map();
  visited = new Set();
  queued = new Set();
  frontier = [];
  cursor = 0;
  beginFresh() {
    if (
      this.started ||
      this.nodes.size ||
      this.visited.size ||
      this.frontier.length
    )
      throw Error('workset not fresh');
    this.started = true;
  }
  register(position, raw) {
    if (this.nodes.has(position)) return false;
    this.nodes.set(position, raw);
    return true;
  }
  read(position) {
    return this.nodes.get(position) ?? null;
  }
  claimVisited(position) {
    if (!this.nodes.has(position)) return 'missing';
    if (this.visited.has(position)) return 'seen';
    this.visited.add(position);
    return 'new';
  }
  enqueue(position) {
    if (!this.nodes.has(position)) return false;
    if (!this.visited.has(position) && !this.queued.has(position)) {
      this.queued.add(position);
      this.frontier.push(position);
    }
    return true;
  }
  dequeue() {
    const key = this.frontier[this.cursor++] ?? null;
    if (key !== null) this.queued.delete(key);
    return key;
  }
}
async function graph(
  fen,
  evidence,
  workset = new RamPrivateWorkset(),
  engine = e,
  options = {},
) {
  return engine.verifyStreamingReachability(
    fen,
    header(evidence),
    records(evidence.nodes),
    { privateWorkset: workset, ...options },
  );
}

test('streamed graph verification matches the bounded kernel and preserves immutable format/count bindings', async () => {
  const proof = e.solveMateReachability(finite, bounds, false);
  assert.equal(proof.status, 'dead');
  assert.equal(
    e.verifyReachabilityDecision(finite, proof.evidence, bounds).verdict,
    'dead',
  );
  const checked = await graph(finite, proof.evidence);
  assert.equal(checked.valid, true);
  assert.equal(checked.verdict, 'dead');
  assert.equal(checked.root, proof.evidence.root);
  assert.equal(checked.format, e.REACHABILITY_STREAM_FORMAT);
  assert.deepEqual(checked.counts, {
    records: '1692',
    nodes: '1692',
    edges: '3557',
    moves: '0',
  });
  assert.ok(Object.isFrozen(checked));
  assert.ok(Object.isFrozen(checked.counts));
  assert.equal(e.isVerifiedStreamingReachabilityDecision(checked), true);
  assert.equal(
    e.isVerifiedStreamingReachabilityDecision(
      JSON.parse(JSON.stringify(checked)),
    ),
    false,
  );
  assert.equal(
    e.isVerifiedStreamingReachabilityDecision({ ...checked }),
    false,
  );
  assert.equal(cjs.isVerifiedStreamingReachabilityDecision(checked), false);
  assert.equal(typeof JSON.stringify(checked), 'string');
  assert.deepEqual(
    await graph(finite, proof.evidence, new RamPrivateWorkset(), cjs),
    checked,
  );
});

test('valid structural leaves are recomputed and only completed same-worker decisions receive provenance', async () => {
  for (const fen of [
    '7k/8/8/8/8/8/8/K7 w - - 0 1',
    '7k/8/8/1p1p1p1p/pPpPpPpP/P1P1P1P1/8/K7 w - - 0 1',
    'kb6/p1p5/P1P5/5pP1/8/8/P1P2P1P/4K3 w - - 0 1',
    '3k1b2/2p1pBp1/KpP1P1P1/1P3B2/4B1B1/5B2/8/8 w - - 3 57',
  ]) {
    const proof = e.solveMateReachability(fen).evidence;
    assert.equal(proof.kind, 'closed-movement-graph');
    const checked = await graph(fen, proof);
    assert.equal(checked.valid, true);
    assert.equal(e.isVerifiedStreamingReachabilityDecision(checked), true);
    const forged = clone(proof);
    forged.nodes[0].leaf = 'forged';
    const rejected = await graph(fen, forged);
    assert.equal(rejected.valid, false);
    assert.equal(e.isVerifiedStreamingReachabilityDecision(rejected), false);
  }
  assert.equal(
    e.isVerifiedStreamingReachabilityDecision({ valid: true, verdict: 'dead' }),
    false,
  );
  assert.equal(
    e.isVerifiedStreamingReachabilityDecision(
      e.verifyReachabilityDecision(
        '7k/8/8/8/8/8/8/K7 w - - 0 1',
        e.solveMateReachability('7k/8/8/8/8/8/8/K7 w - - 0 1').evidence,
      ),
    ),
    false,
  );
});

test('a real 7224-node cyclic proof streams beyond a deliberately small old baseline without a total-record cutoff', async () => {
  const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1',
    proof = e.solveMateReachability(fen, bounds, false).evidence;
  assert.equal(
    e.verifyReachabilityEvidence(fen, proof, {
      maxPositions: 64,
      maxExpanded: 64,
      maxEdges: 64,
    }).valid,
    false,
  );
  const scratch = new RamPrivateWorkset(),
    checked = await graph(fen, proof, scratch);
  assert.equal(checked.valid, true);
  assert.equal(checked.verdict, 'dead');
  assert.deepEqual(checked.counts, {
    records: '7224',
    nodes: '7224',
    edges: '44352',
    moves: '0',
  });
  assert.equal(scratch.visited.size, 7224);
  await assert.rejects(graph(fen, proof, scratch), /not fresh/);
});

test('missing, duplicate, open, forged, extra and checkmating graph nodes produce no verdict', async () => {
  const original = e.solveMateReachability(finite, bounds, false).evidence;
  for (const mutate of [
    (p) => {
      p.nodes.push(p.nodes[0]);
    },
    (p) => {
      p.nodes.shift();
    },
    (p) => {
      p.nodes = p.nodes.filter(
        (node) => node.position !== p.nodes[0].successors[0],
      );
    },
    (p) => {
      p.nodes[0].successors.pop();
    },
    (p) => {
      p.nodes[0].leaf = 'material';
      p.nodes[0].successors = [];
    },
    (p) => {
      p.nodes.push({
        position: '7k/8/8/8/8/8/8/K7 w - -',
        leaf: 'material',
        successors: [],
      });
    },
    (p) => {
      p.nodes[0].expanded = true;
      p.nodes[0].visited = true;
    },
  ]) {
    const bad = clone(original);
    mutate(bad);
    const checked = await graph(finite, bad);
    assert.equal(checked.valid, false);
    assert.equal(checked.verdict, undefined);
  }
  const mate = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1';
  const bad = {
    ...original,
    root: e.positionKey(e.parseFen(mate)),
    nodes: [
      { position: e.positionKey(e.parseFen(mate)), leaf: null, successors: [] },
    ],
  };
  assert.equal((await graph(mate, bad)).valid, false);
});

test('stored key/corruption and wrong header format/root/rights/turn/version are rejected', async () => {
  const original = e.solveMateReachability(finite, bounds, false).evidence;
  for (const read of [
    () =>
      JSON.stringify({
        position: '7k/8/8/8/8/8/8/K7 w - -',
        leaf: 'material',
        successors: [],
      }),
    (raw) => {
      const p = JSON.parse(raw);
      p.successors = [];
      return JSON.stringify(p);
    },
  ]) {
    const workset = new RamPrivateWorkset(),
      base = workset.read.bind(workset);
    workset.read = (key) => read(base(key));
    const checked = await graph(finite, original, workset);
    assert.equal(checked.valid, false);
    assert.equal(checked.verdict, undefined);
  }
  for (const field of ['format', 'root', 'engineVersion', 'rulesVersion']) {
    const parsed = JSON.parse(header(original));
    parsed[field] = 'wrong';
    const checked = await e.verifyStreamingReachability(
      finite,
      JSON.stringify(parsed),
      records(original.nodes),
      { privateWorkset: new RamPrivateWorkset() },
    );
    assert.equal(checked.valid, false);
    assert.equal(checked.verdict, undefined);
  }
  for (const fen of [
    finite.replace(' KQ ', ' Q '),
    finite.replace(' w ', ' b '),
  ])
    assert.equal((await graph(fen, original)).valid, false);
  const ep = 'kb6/p1p5/P1P5/5pP1/5P2/8/8/4K3 w - f6 0 1',
    epProof = e.solveMateReachability(ep).evidence;
  assert.equal((await graph(ep, epProof)).valid, true);
  assert.equal((await graph(ep.replace(' f6 ', ' - '), epProof)).valid, false);
});

test('bounded record framing rejects oversized input before parse and never uses supplied outcome/count flags', async () => {
  const evidence = e.solveMateReachability(
    '7k/8/8/8/8/8/8/K7 w - - 0 1',
  ).evidence;
  const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1';
  async function* oversized() {
    yield ' '.repeat(e.REACHABILITY_STREAM_MAX_RECORD_CHARS + 1);
  }
  assert.equal(
    (
      await e.verifyStreamingReachability(fen, header(evidence), oversized(), {
        privateWorkset: new RamPrivateWorkset(),
      })
    ).valid,
    false,
  );
  const scratch = new RamPrivateWorkset();
  assert.equal(
    (
      await e.verifyStreamingReachability(
        fen,
        ' '.repeat(2049),
        records(evidence.nodes),
        { privateWorkset: scratch },
      )
    ).valid,
    false,
  );
  assert.equal(scratch.started, false);
  const bad = JSON.parse(header(evidence));
  bad.verdict = 'dead';
  bad.nodeCount = 1;
  assert.equal(
    (
      await e.verifyStreamingReachability(
        fen,
        JSON.stringify(bad),
        records(evidence.nodes),
        { privateWorkset: new RamPrivateWorkset() },
      )
    ).valid,
    false,
  );
});

test('stream/storage interruption and abort throw operational failure with no decision', async () => {
  const evidence = e.solveMateReachability(finite, bounds, false).evidence;
  async function* interrupted() {
    yield JSON.stringify(evidence.nodes[0]);
    throw Error('source interrupted');
  }
  await assert.rejects(
    e.verifyStreamingReachability(finite, header(evidence), interrupted(), {
      privateWorkset: new RamPrivateWorkset(),
    }),
    /source interrupted/,
  );
  const failed = new RamPrivateWorkset();
  failed.register = () => {
    throw Error('private storage offline');
  };
  await assert.rejects(graph(finite, evidence, failed), /storage offline/);
  const before = new RamPrivateWorkset();
  await assert.rejects(
    graph(finite, evidence, before, e, { signal: { aborted: true } }),
    { name: 'AbortError' },
  );
  assert.equal(before.started, false);
  const signal = { aborted: false },
    during = new RamPrivateWorkset();
  let closed = false;
  async function* aborting() {
    try {
      yield JSON.stringify(evidence.nodes[0]);
      signal.aborted = true;
      yield JSON.stringify(evidence.nodes[1]);
    } finally {
      closed = true;
    }
  }
  await assert.rejects(
    e.verifyStreamingReachability(finite, header(evidence), aborting(), {
      privateWorkset: during,
      signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(closed, true);
  const traversing = { aborted: false },
    workset = new RamPrivateWorkset(),
    read = workset.read.bind(workset);
  workset.read = (key) => {
    traversing.aborted = true;
    return read(key);
  };
  await assert.rejects(
    graph(finite, evidence, workset, e, { signal: traversing }),
    { name: 'AbortError' },
  );
});

test('optional checked bookkeeping follows complete math/membership and cannot supply a verdict', async () => {
  const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1',
    leaf = e.solveMateReachability(fen).evidence;
  const complete = new RamPrivateWorkset(),
    marked = [];
  complete.checked = (key) => {
    marked.push(key);
  };
  const verified = await graph(fen, leaf, complete);
  assert.equal(verified.valid, true);
  assert.deepEqual(marked, [leaf.root]);
  const open = e.solveMateReachability(finite, bounds, false).evidence;
  open.nodes = open.nodes.filter(
    (node) => node.position !== open.nodes[0].successors[0],
  );
  const missing = new RamPrivateWorkset(),
    missingMarks = [];
  missing.checked = (key) => {
    missingMarks.push(key);
  };
  assert.equal((await graph(finite, open, missing)).valid, false);
  assert.deepEqual(missingMarks, []);
  const invalid = clone(leaf);
  invalid.nodes[0].leaf = 'forged';
  const bad = new RamPrivateWorkset(),
    badMarks = [];
  bad.checked = (key) => {
    badMarks.push(key);
  };
  assert.equal((await graph(fen, invalid, bad)).valid, false);
  assert.deepEqual(badMarks, []);
  const signal = { aborted: false },
    interrupted = new RamPrivateWorkset(),
    read = interrupted.read.bind(interrupted),
    interruptedMarks = [];
  interrupted.read = (key) => {
    signal.aborted = true;
    return read(key);
  };
  interrupted.checked = (key) => {
    interruptedMarks.push(key);
  };
  await assert.rejects(graph(fen, leaf, interrupted, e, { signal }), {
    name: 'AbortError',
  });
  assert.deepEqual(interruptedMarks, []);
  const failed = new RamPrivateWorkset();
  failed.checked = () => {
    throw Error('checked persistence failed');
  };
  await assert.rejects(graph(fen, leaf, failed), /checked persistence failed/);
});

const fool = [
  { from: 'f2', to: 'f3' },
  { from: 'e7', to: 'e5' },
  { from: 'g2', to: 'g4' },
  { from: 'd8', to: 'h4' },
];
const witness = (fen, moves = fool) => ({
  kind: 'reachable-mate',
  engineVersion: e.ENGINE_VERSION,
  rulesVersion: e.RULES_VERSION,
  root: e.positionKey(e.parseFen(fen)),
  winner: 'black',
  moves,
});
test('streamed witnesses verify legal edges, terminal mate and winner with no graph workset', async () => {
  const proof = witness(e.START_FEN),
    checked = await e.verifyStreamingReachability(
      e.START_FEN,
      header(proof),
      records(proof.moves),
    );
  assert.equal(checked.valid, true);
  assert.equal(checked.verdict, 'not-dead');
  assert.deepEqual(checked.counts, {
    records: '4',
    nodes: '0',
    edges: '4',
    moves: '4',
  });
  assert.deepEqual(
    await cjs.verifyStreamingReachability(
      e.START_FEN,
      header(proof),
      records(proof.moves),
    ),
    checked,
  );
  for (const moves of [
    [{ from: 'e2', to: 'e5' }],
    fool.slice(0, 3),
    [...fool, { from: 'e2', to: 'e4' }],
  ]) {
    const invalid = await e.verifyStreamingReachability(
      e.START_FEN,
      header(proof),
      records(moves),
    );
    assert.equal(invalid.valid, false);
    assert.equal(invalid.verdict, undefined);
  }
  const wrong = { ...proof, winner: 'white' };
  assert.equal(
    (
      await e.verifyStreamingReachability(
        e.START_FEN,
        header(wrong),
        records(fool),
      )
    ).valid,
    false,
  );
  const mate = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1',
    zero = { ...witness(mate, []), winner: 'white' };
  assert.equal(
    (await e.verifyStreamingReachability(mate, header(zero), records([])))
      .valid,
    true,
  );
  assert.equal(
    (
      await e.verifyStreamingReachability(
        mate,
        header(zero),
        records([{ from: 'h8', to: 'h7' }]),
      )
    ).valid,
    false,
  );
});

test('an unlimited-total witness exceeds the old edge limit while irrelevant FEN counters stay normalised', async () => {
  const cycle = [
    { from: 'g1', to: 'f3' },
    { from: 'g8', to: 'f6' },
    { from: 'f3', to: 'g1' },
    { from: 'f6', to: 'g8' },
  ];
  const moves = Array.from({ length: 2050 }, () => cycle)
      .flat()
      .concat(fool),
    proof = witness(e.START_FEN, moves);
  assert.equal(e.verifyReachabilityEvidence(e.START_FEN, proof).valid, false);
  const fen = e.START_FEN.replace(' 0 1', ' 1000000 1000000');
  async function* generated() {
    for (let i = 0; i < 2050; i++)
      for (const move of cycle) yield JSON.stringify(move);
    for (const move of fool) yield JSON.stringify(move);
  }
  const checked = await e.verifyStreamingReachability(
    fen,
    header(proof),
    generated(),
  );
  assert.equal(checked.valid, true);
  assert.equal(checked.verdict, 'not-dead');
  assert.equal(checked.counts.moves, '8204');
  assert.equal(checked.root, proof.root);
});
