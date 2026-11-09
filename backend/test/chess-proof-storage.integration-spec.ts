import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { before, after, describe, it } from 'node:test';
import { Pool } from 'pg';
import * as chess from '#engines/chess';
import {
  ChessProofRepository,
  type CheckedProofArtifactDescriptor,
} from '../src/tables/chess-proof-repository';

interface Verified {
  ok: boolean;
  code?: string;
  descriptor: CheckedProofArtifactDescriptor;
  summary: chess.VerifiedStreamingReachabilityDecision;
  cloneRejected: boolean;
  foreignRejected: boolean;
  bindingAccepted: boolean;
  name?: string;
  budgetStopObserved?: boolean;
}
interface FirstParent {
  parent_key: string;
  parent_move: string;
  discovery_seq: string;
}
const runFile = promisify(execFile);
void describe('durable chess proof storage in isolated PostgreSQL', () => {
  let admin: Pool, pool: Pool, url: string, repository: ChessProofRepository;
  const schema = 'proofs_' + randomUUID().replaceAll('-', '');
  before(async () => {
    const target = new URL(process.env.TEST_DATABASE_URL ?? '');
    assert.match(target.pathname, /_test$/);
    admin = new Pool({ connectionString: target.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    target.searchParams.set('application_name', schema);
    url = target.href;
    pool = new Pool({ connectionString: url });
    repository = new ChessProofRepository(pool);
    for (const file of (await readdir('migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort())
      await pool.query(await readFile('migrations/' + file, 'utf8'));
  });
  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  function bare(square: number) {
    const p = chess.parseFen('7k/8/8/8/8/8/8/K7 w - - 0 1');
    p.board[0] = null;
    p.board[square] = 'K';
    return chess.toFen(p);
  }
  function header(
    fen: string,
    kind: 'closed-movement-graph' | 'reachable-mate',
    winner?: chess.Color,
  ): chess.ReachabilityStreamHeader {
    const common = {
      format: chess.REACHABILITY_STREAM_FORMAT,
      root: chess.positionKey(chess.parseFen(fen)),
      engineVersion: chess.ENGINE_VERSION,
      rulesVersion: chess.RULES_VERSION,
    };
    return kind === 'reachable-mate'
      ? { ...common, kind, winner: winner! }
      : { ...common, kind };
  }
  async function prepared(
    fen: string,
    records: readonly unknown[],
    h = header(fen, 'closed-movement-graph'),
  ) {
    return repository.withWork(fen, async (work) => {
      if ((await work.metadata()).stage === 'sealed') return work.id;
      await work.beginExport(h);
      let chunk = '';
      for (const record of records) {
        const line = JSON.stringify(record) + '\n';
        if (Buffer.byteLength(chunk + line) > 100_000) {
          await work.appendChunk(Buffer.from(chunk), 'records');
          chunk = '';
        }
        chunk += line;
      }
      if (chunk) await work.appendChunk(Buffer.from(chunk), 'end');
      await work.seal();
      return work.id;
    });
  }
  async function verify(
    workId: string,
    fen: string,
    artifactId?: string,
    solve = false,
    connectionString = url,
    forceProbeBudgetStop = false,
  ): Promise<Verified> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        require.resolve('./chess-proof-storage-worker'),
        {
          workerData: {
            url: connectionString,
            workId,
            fen,
            ...(artifactId ? { artifactId } : {}),
            solve,
            forceProbeBudgetStop,
          },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
      let result: Verified | undefined;
      worker.on('message', (value: Verified) => {
        result = value;
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0 || !result)
          reject(new Error('Proof test worker failed'));
        else resolve(result);
      });
    });
  }

  void it('stores a checkpointed FIFO frontier without account locks/open SQL transactions and resumes committed discovery after interruption', async () => {
    const fen = bare(1),
      root = chess.positionKey(chess.parseFen(fen)),
      a = bare(0).replace(' w ', ' b '),
      b = bare(2).replace(' w ', ' b ');
    let workId = '';
    await assert.rejects(
      repository.withWork(fen, async (work) => {
        workId = work.id;
        assert.equal((await work.nextPending())?.key, root);
        const activity = (
          await pool.query<{ state: string; xact_start: Date | null }>(
            "SELECT state,xact_start FROM pg_stat_activity WHERE application_name=$1 AND pid IN(SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted)",
            [schema],
          )
        ).rows;
        assert.equal(activity.length, 1);
        assert.equal(activity[0]!.state, 'idle');
        assert.equal(activity[0]!.xact_start, null);
        await work.commitExpansion({
          key: root,
          classification: 'branch',
          children: [
            { key: chess.positionKey(chess.parseFen(a)), fen: a, move: 'b1a1' },
            { key: chess.positionKey(chess.parseFen(b)), fen: b, move: 'b1c1' },
            ...[
              [8, 'a2'],
              [9, 'b2'],
              [10, 'c2'],
            ].map(([square, to]) => {
              const child = bare(Number(square)).replace(' w ', ' b ');
              return {
                key: chess.positionKey(chess.parseFen(child)),
                fen: child,
                move: 'b1' + String(to),
              };
            }),
            { key: chess.positionKey(chess.parseFen(a)), fen: a, move: 'b1a1' },
          ],
        });
        throw new Error('Simulated builder interruption after commit');
      }),
      /interruption/,
    );
    await repository.withWork(fen, async (work) => {
      assert.equal(work.id, workId);
      assert.equal(
        (await work.nextPending())?.key,
        chess.positionKey(chess.parseFen(a)),
      );
      await work.commitExpansion({
        key: chess.positionKey(chess.parseFen(a)),
        classification: 'material',
        children: [],
      });
      assert.equal(
        (await work.nextPending())?.key,
        chess.positionKey(chess.parseFen(b)),
      );
      assert.equal((await work.metadata()).next_discovery, '6');
      const key = chess.positionKey(chess.parseFen(a));
      const firstParent = (
        await pool.query<FirstParent>(
          'SELECT parent_key,parent_move,discovery_seq FROM chess_proof_search_nodes WHERE work_id=$1 AND key=$2',
          [work.id, key],
        )
      ).rows[0];
      // An ignored duplicate discovery does not allocate a number or replace
      // its first parent, even if a later builder proposes another ancestry.
      await pool.query(
        "INSERT INTO chess_proof_search_nodes(work_id,key,fen,parent_key,parent_move) VALUES($1,$2,$3,$4,'c1a1') ON CONFLICT(work_id,key) DO NOTHING",
        [work.id, key, a, chess.positionKey(chess.parseFen(b))],
      );
      assert.deepEqual(
        (
          await pool.query<FirstParent>(
            'SELECT parent_key,parent_move,discovery_seq FROM chess_proof_search_nodes WHERE work_id=$1 AND key=$2',
            [work.id, key],
          )
        ).rows[0],
        firstParent,
      );
      assert.equal((await work.metadata()).next_discovery, '6');
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM chess_proof_search_edges WHERE work_id=$1',
            [work.id],
          )
        ).rowCount,
        5,
      );
    });
  });

  void it('rolls children/edges/expanded/counters back together when one expansion write fails', async () => {
    const fen = bare(4),
      root = chess.positionKey(chess.parseFen(fen));
    await repository.withWork(fen, async (work) => {
      await assert.rejects(
        work.commitExpansion({
          key: root,
          classification: 'branch',
          children: [
            {
              key: chess.positionKey(chess.parseFen(bare(5))),
              fen: bare(5),
              move: 'e1f1',
            },
            {
              key: chess.positionKey(chess.parseFen(bare(6))),
              fen: bare(6),
              move: 'invalid',
            },
          ],
        }),
      );
      assert.equal((await work.metadata()).next_discovery, '1');
      assert.equal((await work.nextPending())?.expanded, false);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM chess_proof_search_edges WHERE work_id=$1',
            [work.id],
          )
        ).rowCount,
        0,
      );
    });
  });

  void it('binds an immutable checked leaf to one exact artifact and rechecks its bytes in a fresh cold worker', async () => {
    const fen = bare(7),
      root = chess.positionKey(chess.parseFen(fen)),
      id = await prepared(fen, [
        { position: root, leaf: 'material', successors: [] },
      ]),
      first = await verify(id, fen);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.summary.verdict, 'dead');
    assert.equal(first.cloneRejected, true);
    assert.equal(first.foreignRejected, true);
    assert.equal(first.bindingAccepted, true);
    const cold = await verify(id, fen, first.descriptor.artifactId);
    assert.equal(cold.ok, true, JSON.stringify(cold));
    assert.deepEqual(cold.descriptor, first.descriptor);
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM chess_proof_artifacts WHERE work_id=$1',
          [id],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM chess_proof_check_runs WHERE work_id=$1',
          [id],
        )
      ).rowCount,
      2,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM chess_proof_check_nodes WHERE work_id=$1 AND mark<>'checked'",
          [id],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      pool.query(
        'UPDATE chess_proof_chunks SET payload=payload WHERE work_id=$1',
        [id],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query('DELETE FROM chess_proof_artifacts WHERE work_id=$1', [id]),
      { code: '23514' },
    );
    await assert.rejects(
      repository.withWork(fen, (work) => work.rejectInvalid()),
      { code: '23514' },
    );
  });

  void it('accepts a root-mate witness with zero body chunks and counts actual witness moves as edges', async () => {
    const mate = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1',
      mateId = await prepared(
        mate,
        [],
        header(mate, 'reachable-mate', 'white'),
      ),
      zero = await verify(mateId, mate);
    assert.equal(zero.ok, true, JSON.stringify(zero));
    assert.deepEqual(zero.summary.counts, {
      records: '0',
      nodes: '0',
      edges: '0',
      moves: '0',
    });
    const moves = [
        { from: 'f2', to: 'f3' },
        { from: 'e7', to: 'e5' },
        { from: 'g2', to: 'g4' },
        { from: 'd8', to: 'h4' },
      ],
      id = await prepared(
        chess.START_FEN,
        moves,
        header(chess.START_FEN, 'reachable-mate', 'black'),
      ),
      checked = await verify(id, chess.START_FEN);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.deepEqual(checked.summary.counts, {
      records: '4',
      nodes: '0',
      edges: '4',
      moves: '4',
    });
  });

  void it('retains rejected malformed transport and creates a fresh attempt without rewriting old bytes', async () => {
    const fen = bare(8),
      root = chess.positionKey(chess.parseFen(fen)),
      raw = { position: root, leaf: 'material', successors: [] },
      invalidId = await prepared(fen, [raw, raw]),
      invalid = await verify(invalidId, fen);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'proof_invalid');
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM chess_proof_artifacts WHERE work_id=$1',
          [invalidId],
        )
      ).rowCount,
      0,
    );
    await repository.withWork(fen, (work) => work.rejectInvalid());
    const nextId = await prepared(fen, [raw]),
      result = await verify(nextId, fen);
    assert.notEqual(nextId, invalidId);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(
      (
        await pool.query<{ attempt_no: string }>(
          'SELECT attempt_no FROM chess_proof_work WHERE id=$1',
          [nextId],
        )
      ).rows[0]!.attempt_no,
      '2',
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM chess_proof_chunks WHERE work_id=$1', [
          invalidId,
        ])
      ).rowCount,
      1,
    );
  });

  void it('rolls chunk append and export cursor back together and rejects unbound header/counter initialisation', async () => {
    const fen = bare(9),
      root = chess.positionKey(chess.parseFen(fen));
    await repository.withWork(fen, async (work) => {
      await assert.rejects(
        work.beginExport({
          ...header(fen, 'closed-movement-graph'),
          root: 'wrong root',
        }),
        { code: '23514' },
      );
      assert.equal((await work.metadata()).stage, 'searching');
      await work.beginExport(header(fen, 'closed-movement-graph'));
      await assert.rejects(
        work.appendChunk(
          Buffer.from(
            JSON.stringify({
              position: root,
              leaf: 'material',
              successors: [],
            }) + '\n',
          ),
          'x'.repeat(300),
        ),
        { code: '23514' },
      );
      assert.equal((await work.metadata()).chunk_count, '0');
      assert.equal((await work.metadata()).export_cursor, '');
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM chess_proof_chunks WHERE work_id=$1',
            [work.id],
          )
        ).rowCount,
        0,
      );
    });
    await assert.rejects(
      pool.query(
        "INSERT INTO chess_proof_work(id,root_key,kernel_engine,kernel_rules,format,attempt_no,next_discovery) VALUES($1,'bad','bad','bad','bad',1,1)",
        [randomUUID()],
      ),
      { code: '23514' },
    );
  });

  void it('resumes a persisted mate and partial ancestry after interruption, without mistaking pending hint nodes for a closed graph', async () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1',
      evidence: chess.ReachableMateWitness = {
        ...header(fen, 'reachable-mate', 'black'),
        kind: 'reachable-mate',
        winner: 'black',
        moves: [
          { from: 'e7', to: 'e5' },
          { from: 'g2', to: 'g4' },
          { from: 'd8', to: 'h4' },
        ],
      };
    let id = '';
    await repository.withWork(fen, async (work) => {
      id = work.id;
      await work.storeWitnessHint(fen, evidence);
      const mate = await work.mate();
      assert.ok(mate);
      await work.beginWitness(mate.key);
      await work.witnessStep();
      assert.equal((await work.metadata()).witness_ready, false);
      assert.equal((await work.nextPending())?.expanded, false);
    });
    const result = await verify(id, fen, undefined, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.summary.verdict, 'not-dead');
    assert.equal(
      (
        await pool.query<{ witness_ready: boolean }>(
          'SELECT witness_ready FROM chess_proof_work WHERE id=$1',
          [id],
        )
      ).rows[0]!.witness_ready,
      true,
    );
  });

  void it('builds live and dead decisions through the worker-only durable driver with no unknown accepted as a verdict', async () => {
    for (const fen of [
      'rnbqkbnr/pppppppp/8/8/6P1/8/PPPPPP1P/RNBQKBNR b KQkq - 0 1',
      bare(12),
    ]) {
      const result = await verify('', fen, undefined, true);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        result.summary.verdict,
        fen === bare(12) ? 'dead' : 'not-dead',
      );
    }
  });

  void it('audits and physically restores immutable proof bytes, then cold-rechecks mathematics independently and detects restored transport corruption', async () => {
    assert.deepEqual(
      (await pool.query('SELECT * FROM chess_proof_integrity_errors()')).rows,
      [],
    );
    const fen = bare(7),
      artifact = (
        await pool.query<{ artifact_id: string; work_id: string }>(
          "SELECT encode(manifest_digest,'hex') AS artifact_id,work_id FROM chess_proof_artifacts WHERE root_key=$1",
          [chess.positionKey(chess.parseFen(fen))],
        )
      ).rows[0]!;
    const directory = await mkdtemp(
        join(tmpdir(), 'skillbetting-proof-restore-'),
      ),
      original = join(directory, 'original.sql'),
      restored = join(directory, 'restored.sql'),
      restoredSchema = schema + '_restore',
      target = new URL(url);
    target.searchParams.delete('options');
    target.searchParams.delete('application_name');
    const adminUrl = target.href;
    target.searchParams.set('options', '-c search_path=' + restoredSchema);
    const restoredUrl = target.href,
      restoredPool = new Pool({ connectionString: restoredUrl });
    try {
      await runFile('pg_dump', [
        '--dbname',
        adminUrl,
        '--schema',
        schema,
        '--no-owner',
        '--no-privileges',
        '--file',
        original,
      ]);
      await writeFile(
        restored,
        (await readFile(original, 'utf8')).replaceAll(schema, restoredSchema),
        { mode: 0o600 },
      );
      await runFile('psql', [
        '--dbname',
        adminUrl,
        '--set',
        'ON_ERROR_STOP=1',
        '--quiet',
        '--file',
        restored,
      ]);
      assert.deepEqual(
        (
          await restoredPool.query(
            'SELECT * FROM chess_proof_integrity_errors()',
          )
        ).rows,
        [],
      );
      const cold = await verify(
        artifact.work_id,
        fen,
        artifact.artifact_id,
        false,
        restoredUrl,
      );
      assert.equal(cold.ok, true, JSON.stringify(cold));
      assert.equal(cold.descriptor.artifactId, artifact.artifact_id);
      // Simulate disk/admin corruption ONLY in the disposable restored copy.
      // Production DML roles cannot disable these guards.
      await restoredPool.query(
        'ALTER TABLE chess_proof_work DISABLE TRIGGER USER',
      );
      await restoredPool.query(
        "UPDATE chess_proof_work SET chain_digest=decode(repeat('00',32),'hex') WHERE id=$1",
        [artifact.work_id],
      );
      await restoredPool.query(
        'ALTER TABLE chess_proof_work ENABLE TRIGGER USER',
      );
      const errors = (
        await restoredPool.query<{ kind: string }>(
          'SELECT * FROM chess_proof_integrity_errors()',
        )
      ).rows;
      assert.ok(errors.some((row) => row.kind === 'work-transport-counts'));
      assert.ok(errors.some((row) => row.kind === 'artifact-manifest'));
      assert.equal(
        (
          await verify(
            artifact.work_id,
            fen,
            artifact.artifact_id,
            false,
            restoredUrl,
          )
        ).ok,
        false,
      );
    } finally {
      await restoredPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${restoredSchema} CASCADE`);
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it('rejects an independently invalid unpublished sealed attempt in the driver, retaining bytes and allowing a fresh correct attempt', async () => {
    const fen = bare(13),
      position = chess.positionKey(chess.parseFen(fen)),
      raw = { position, leaf: 'material', successors: [] },
      oldId = await prepared(fen, [raw, raw]);
    const invalid = await verify('', fen, undefined, true);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'proof_invalid');
    assert.equal(
      (
        await pool.query<{ stage: string }>(
          'SELECT stage FROM chess_proof_work WHERE id=$1',
          [oldId],
        )
      ).rows[0]!.stage,
      'rejected',
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM chess_proof_chunks WHERE work_id=$1', [
          oldId,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM chess_proof_artifacts WHERE work_id=$1',
          [oldId],
        )
      ).rowCount,
      0,
    );
    const corrected = await verify('', fen, undefined, true);
    assert.equal(corrected.ok, true, JSON.stringify(corrected));
    assert.equal(corrected.summary.verdict, 'dead');
    assert.equal(
      (
        await pool.query<{ attempt_no: string }>(
          "SELECT attempt_no FROM chess_proof_work WHERE root_key=$1 AND stage='sealed'",
          [position],
        )
      ).rows[0]!.attempt_no,
      '2',
    );
  });

  void it('abandons the positive probe at its heap budget without inventing a chess verdict or proof, and leaves its durable frontier available for retry', async () => {
    const fen = '3k1b2/2p1pBp1/KpP1P1P1/1P3B2/2B1B1B1/8/4q3/8 w - - 0 1';
    // Only this disposable test worker reports a high heap. It then cancels
    // after the budget check so this test does not deliberately run the slower
    // complete frontier; the following test resumes that exact pending work.
    const stopped = await verify('', fen, undefined, true, url, true);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.budgetStopObserved, true);
    assert.equal(stopped.name, 'AbortError');
    await repository.withWork(fen, async (work) => {
      const metadata = await work.metadata();
      assert.equal(metadata.stage, 'searching');
      assert.equal(metadata.next_discovery, '1');
      assert.equal((await work.nextPending())?.expanded, false);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM chess_proof_chunks WHERE work_id=$1',
            [work.id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM chess_proof_artifacts WHERE work_id=$1',
            [work.id],
          )
        ).rowCount,
        0,
      );
    });
  });

  void it('finds a short live witness with a bounded generic breadth-first probe and resumes an existing frontier without discarding first parents', async () => {
    // This is a genuine live position from the published standard-start
    // proofgame immediately before the final capture produces a dead ending.
    const fen = '3k1b2/2p1pBp1/KpP1P1P1/1P3B2/2B1B1B1/8/4q3/8 w - - 0 1';
    let rootId = '',
      firstChild = '';
    await repository.withWork(fen, async (work) => {
      rootId = work.id;
      const expansion = chess.expandReachabilityPosition(fen);
      assert.equal(expansion.kind, 'branch');
      if (expansion.kind !== 'branch')
        throw new Error('Expected a live branching fixture');
      firstChild = expansion.successors[0]!.position;
      await work.commitExpansion({
        key: expansion.position,
        classification: 'branch',
        children: expansion.successors.map((s) => ({
          key: s.position,
          fen: s.fen,
          move: chess.uci(s.move),
        })),
      });
    });
    const before = (
      await pool.query<FirstParent>(
        'SELECT parent_key,parent_move,discovery_seq FROM chess_proof_search_nodes WHERE work_id=$1 AND key=$2',
        [rootId, firstChild],
      )
    ).rows[0];
    const result = await verify('', fen, undefined, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.summary.verdict, 'not-dead');
    assert.equal(result.summary.counts.moves, '4');
    assert.deepEqual(
      (
        await pool.query<FirstParent>(
          'SELECT parent_key,parent_move,discovery_seq FROM chess_proof_search_nodes WHERE work_id=$1 AND key=$2',
          [rootId, firstChild],
        )
      ).rows[0],
      before,
    );
    assert.deepEqual(
      (await pool.query('SELECT * FROM chess_proof_integrity_errors()')).rows,
      [],
    );
  });

  void it(
    'checks a real 7224-node cyclic graph across multiple physical chunks using fresh PostgreSQL membership/frontier namespaces, and rejects missing, duplicate and unreachable records',
    { timeout: 180_000 },
    async () => {
      const fen = bare(0),
        proof = chess.solveMateReachability(
          fen,
          {
            maxPositions: 10_000,
            maxExpanded: 10_000,
            maxEdges: 100_000,
          },
          false,
        );
      assert.equal(proof.status, 'dead');
      if (proof.status !== 'dead')
        throw new Error('Expected complete finite king-movement graph');
      assert.equal(proof.evidence.nodes.length, 7224);
      assert.ok(
        proof.evidence.nodes.some((node) =>
          node.successors.includes(proof.evidence.root),
        ),
        'Actual cycle must revisit the root',
      );
      const id = await prepared(fen, proof.evidence.nodes),
        checked = await verify(id, fen);
      assert.equal(checked.ok, true, JSON.stringify(checked));
      assert.deepEqual(checked.summary.counts, {
        records: '7224',
        nodes: '7224',
        edges: '44352',
        moves: '0',
      });
      assert.ok(
        (
          await pool.query(
            'SELECT 1 FROM chess_proof_chunks WHERE work_id=$1',
            [id],
          )
        ).rowCount! >= 2,
      );
      const cold = await verify(id, fen, checked.descriptor.artifactId);
      assert.equal(cold.ok, true, JSON.stringify(cold));
      assert.deepEqual(cold.descriptor, checked.descriptor);
      const checks = (
        await pool.query<{
          id: string;
          registered_count: string;
          claimed_count: string;
          checked_count: string;
          queued_count: string;
          stage: string;
        }>(
          'SELECT id,registered_count,claimed_count,checked_count,queued_count,stage FROM chess_proof_check_runs WHERE work_id=$1',
          [id],
        )
      ).rows;
      assert.equal(checks.length, 2);
      for (const run of checks) {
        assert.equal(run.stage, 'complete');
        assert.equal(run.registered_count, '7224');
        assert.equal(run.claimed_count, '7224');
        assert.equal(run.checked_count, '7224');
        assert.equal(run.queued_count, '0');
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM chess_proof_check_nodes WHERE run_id=$1 AND (mark<>'checked' OR queued)",
              [run.id],
            )
          ).rowCount,
          0,
        );
      }
      const extra = chess.expandReachabilityPosition(
        '7k/8/8/8/8/8/1K6/6B1 w - - 0 1',
      );
      assert.equal(extra.kind, 'leaf');
      if (extra.kind !== 'leaf')
        throw new Error('Expected a valid but unreachable extra leaf');
      const variants = [
        proof.evidence.nodes.slice(1),
        [...proof.evidence.nodes, proof.evidence.nodes[0]!],
        [...proof.evidence.nodes, extra.node],
      ];
      for (let index = 0; index < variants.length; index++) {
        // Every bare-kings root is in this complete movement graph. Changing the
        // starting square gives an independent, unreferenced corrupt attempt.
        const corruptFen = bare(16 + index),
          corruptId = await prepared(corruptFen, variants[index]!),
          rejected = await verify(corruptId, corruptFen);
        assert.equal(rejected.ok, false);
        assert.equal(rejected.code, 'proof_invalid');
        assert.equal(
          (
            await pool.query(
              'SELECT 1 FROM chess_proof_artifacts WHERE work_id=$1',
              [corruptId],
            )
          ).rowCount,
          0,
        );
        await repository.withWork(corruptFen, (work) => work.rejectInvalid());
      }
      assert.deepEqual(
        (await pool.query('SELECT * FROM chess_proof_integrity_errors()')).rows,
        [],
      );
    },
  );
});
