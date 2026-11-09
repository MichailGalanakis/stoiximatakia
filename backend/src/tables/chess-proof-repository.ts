import { createHash, randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import type { Pool, PoolClient } from 'pg';
import * as chess from '#engines/chess';

const ARTIFACT_FORMAT = 'skillbetting.chess.proof-artifact.v1';
const CHUNK_BYTES = 1_048_576;
const chainSeed = (header: string): Buffer =>
  hash(Buffer.from('skillbetting.chess.stream-chain.v1:' + header));
const hash = (bytes: Buffer): Buffer =>
  createHash('sha256').update(bytes).digest();
const nextChain = (
  previous: Buffer,
  ordinal: string,
  bytes: Buffer,
  digest: Buffer,
): Buffer =>
  hash(
    Buffer.concat([
      previous,
      Buffer.from(ordinal + ':' + bytes.length + ':'),
      digest,
    ]),
  );
type Classification =
  | 'branch'
  | 'mate'
  | 'stalemate'
  | 'material'
  | 'locked'
  | 'king-corridor'
  | 'temporal';
interface WorkRow {
  id: string;
  root_key: string;
  kernel_engine: string;
  kernel_rules: string;
  format: string;
  attempt_no: string;
  stage: 'searching' | 'exporting' | 'sealed' | 'rejected';
  next_discovery: string;
  witness_tip: string | null;
  witness_cursor: string | null;
  witness_ready: boolean;
  proof_kind: chess.ReachabilityStreamHeader['kind'] | null;
  header_json: string | null;
  export_cursor: string | null;
  chunk_count: string;
  byte_count: string;
  chain_digest: Buffer | null;
}
interface ChunkRow {
  ordinal: string;
  payload: Buffer;
  digest: Buffer;
  previous_chain: Buffer;
  chain_digest: Buffer;
}
export interface ProofSearchNode {
  key: string;
  fen: string;
  parent_key: string | null;
  parent_move: string | null;
  discovery_seq: string;
  expanded: boolean;
  classification: 'pending' | Classification;
}
interface Locator {
  ordinal: string;
  offset: number;
  bytes: number;
  digest: Buffer;
  raw: string;
}
interface CheckBinding {
  work: WorkRow;
  runId: string;
  summary: chess.VerifiedStreamingReachabilityDecision;
}
export class ChessProofStorageError extends Error {
  constructor(
    readonly code: 'storage_state' | 'proof_invalid' | 'worker_required',
  ) {
    super(code);
  }
}
export interface CheckedProofArtifactDescriptor {
  readonly artifactId: string;
  readonly root: string;
  readonly kernelEngineVersion: typeof chess.ENGINE_VERSION;
  readonly kernelRulesVersion: typeof chess.RULES_VERSION;
  readonly format: typeof chess.REACHABILITY_STREAM_FORMAT;
}
function requireValue<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new ChessProofStorageError('storage_state');
  return value;
}
async function transaction<T>(
  client: PoolClient,
  run: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const value = await run();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
const questionKey = (
  work: Pick<WorkRow, 'root_key' | 'kernel_engine' | 'kernel_rules' | 'format'>,
) =>
  JSON.stringify([
    work.root_key,
    work.kernel_engine,
    work.kernel_rules,
    work.format,
  ]);

/** A scoped, advisory-locked builder; it never holds a SQL transaction across search. */
export class ChessProofWork {
  private active = true;
  constructor(
    private readonly client: PoolClient,
    readonly id: string,
  ) {}
  release(): void {
    this.active = false;
  }
  private available(): void {
    if (!this.active) throw new ChessProofStorageError('storage_state');
  }
  async metadata(): Promise<WorkRow> {
    this.available();
    return requireValue(
      (
        await this.client.query<WorkRow>(
          'SELECT * FROM chess_proof_work WHERE id=$1',
          [this.id],
        )
      ).rows[0],
    );
  }
  async nextPending(): Promise<ProofSearchNode | null> {
    this.available();
    return (
      (
        await this.client.query<ProofSearchNode>(
          'SELECT key,fen,parent_key,parent_move,discovery_seq,expanded,classification FROM chess_proof_search_nodes WHERE work_id=$1 AND NOT expanded ORDER BY discovery_seq LIMIT 1',
          [this.id],
        )
      ).rows[0] ?? null
    );
  }
  async mate(): Promise<ProofSearchNode | null> {
    this.available();
    return (
      (
        await this.client.query<ProofSearchNode>(
          "SELECT key,fen,parent_key,parent_move,discovery_seq,expanded,classification FROM chess_proof_search_nodes WHERE work_id=$1 AND classification='mate' ORDER BY discovery_seq LIMIT 1",
          [this.id],
        )
      ).rows[0] ?? null
    );
  }
  /** Bounded positive hints are only an optimisation; parent pointers retain first discovery. */
  async storeWitnessHint(
    fen: string,
    evidence: chess.ReachableMateWitness,
  ): Promise<void> {
    this.available();
    const checked = chess.verifyReachabilityDecision(fen, evidence, {
      maxEdges: 256,
    });
    if (!checked.valid || checked.verdict !== 'not-dead')
      throw new ChessProofStorageError('proof_invalid');
    let current = chess.positionKey(chess.parseFen(fen));
    const nodes = [{ key: current, fen: current + ' 0 1', move: '' }],
      positions = new Map([[current, 0]]);
    for (const move of evidence.moves) {
      const expanded = chess.expandReachabilityPosition(current + ' 0 1');
      if (expanded.kind !== 'branch')
        throw new ChessProofStorageError('proof_invalid');
      const next = expanded.successors.find(
        (s) => chess.uci(s.move) === chess.uci(move),
      );
      if (!next) throw new ChessProofStorageError('proof_invalid');
      current = next.position;
      const previous = positions.get(current);
      if (previous !== undefined) {
        for (const removed of nodes.splice(previous + 1))
          positions.delete(removed.key);
      } else {
        positions.set(current, nodes.length);
        nodes.push({ key: current, fen: next.fen, move: chess.uci(move) });
      }
    }
    const ending = chess.expandReachabilityPosition(current + ' 0 1');
    if (ending.kind !== 'mate' || ending.winner !== evidence.winner)
      throw new ChessProofStorageError('proof_invalid');
    await transaction(this.client, async () => {
      for (let index = 1; index < nodes.length; index++) {
        const node = nodes[index]!;
        await this.client.query(
          'INSERT INTO chess_proof_search_nodes(work_id,key,fen,parent_key,parent_move) VALUES($1,$2,$3,$4,$5) ON CONFLICT(work_id,key) DO NOTHING',
          [this.id, node.key, node.fen, nodes[index - 1]!.key, node.move],
        );
      }
      // Hint nodes are not falsely marked as full graph expansions.
      const end = requireValue(
        (
          await this.client.query<{
            expanded: boolean;
            classification: string;
          }>(
            'SELECT expanded,classification FROM chess_proof_search_nodes WHERE work_id=$1 AND key=$2 FOR UPDATE',
            [this.id, current],
          )
        ).rows[0],
      );
      if (!end.expanded)
        await this.client.query(
          "UPDATE chess_proof_search_nodes SET expanded=true,classification='mate' WHERE work_id=$1 AND key=$2",
          [this.id, current],
        );
      else if (end.classification !== 'mate')
        throw new ChessProofStorageError('storage_state');
    });
  }
  async beginWitness(tip: string): Promise<void> {
    this.available();
    await this.client.query(
      'UPDATE chess_proof_work SET witness_tip=$2,witness_cursor=$2,witness_ready=($2=root_key) WHERE id=$1 AND witness_tip IS NULL',
      [this.id, tip],
    );
  }
  /** One bounded first-parent step, cursor and forward link committed together. */
  async witnessStep(): Promise<void> {
    this.available();
    await transaction(this.client, async () => {
      const work = requireValue(
        (
          await this.client.query<WorkRow>(
            'SELECT * FROM chess_proof_work WHERE id=$1 FOR UPDATE',
            [this.id],
          )
        ).rows[0],
      );
      if (work.witness_ready) return;
      const child = requireValue(
        (
          await this.client.query<{ key: string; parent_key: string | null }>(
            'SELECT key,parent_key FROM chess_proof_search_nodes WHERE work_id=$1 AND key=$2',
            [this.id, work.witness_cursor],
          )
        ).rows[0],
      );
      const parent = requireValue(child.parent_key);
      await this.client.query(
        'UPDATE chess_proof_search_nodes SET witness_next=$3 WHERE work_id=$1 AND key=$2 AND witness_next IS NULL',
        [this.id, parent, child.key],
      );
      await this.client.query(
        'UPDATE chess_proof_work SET witness_cursor=$2,witness_ready=($2=root_key) WHERE id=$1',
        [this.id, parent],
      );
    });
  }
  async exportRecord(
    kind: chess.ReachabilityStreamHeader['kind'],
    cursor: string,
  ): Promise<{ raw: string; cursor: string } | null> {
    this.available();
    if (kind === 'reachable-mate') {
      const work = await this.metadata(),
        source = cursor || work.root_key;
      const child = (
        await this.client.query<{ key: string; parent_move: string }>(
          'SELECT c.key,c.parent_move FROM chess_proof_search_nodes p JOIN chess_proof_search_nodes c ON c.work_id=p.work_id AND c.key=p.witness_next WHERE p.work_id=$1 AND p.key=$2',
          [this.id, source],
        )
      ).rows[0];
      if (!child) {
        if (source !== work.witness_tip)
          throw new ChessProofStorageError('storage_state');
        return null;
      }
      const coordinate = child.parent_move;
      return {
        raw: JSON.stringify({
          from: coordinate.slice(0, 2),
          to: coordinate.slice(2, 4),
          ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
        }),
        cursor: child.key,
      };
    }
    const node = (
      await this.client.query<ProofSearchNode>(
        'SELECT key,classification,expanded FROM chess_proof_search_nodes WHERE work_id=$1 AND key>$2 ORDER BY key LIMIT 1',
        [this.id, cursor],
      )
    ).rows[0];
    if (!node) return null;
    if (
      !node.expanded ||
      node.classification === 'pending' ||
      node.classification === 'mate'
    )
      throw new ChessProofStorageError('storage_state');
    const successors =
      node.classification === 'branch'
        ? (
            await this.client.query<{ to_key: string }>(
              'SELECT to_key FROM chess_proof_search_edges WHERE work_id=$1 AND from_key=$2 ORDER BY to_key',
              [this.id, node.key],
            )
          ).rows.map((row) => row.to_key)
        : [];
    return {
      raw: JSON.stringify({
        position: node.key,
        leaf: node.classification === 'branch' ? null : node.classification,
        successors,
      }),
      cursor: node.key,
    };
  }
  async commitExpansion(input: {
    key: string;
    classification: Classification;
    children: readonly { key: string; fen: string; move: string }[];
  }): Promise<void> {
    this.available();
    if (
      chess.positionKey(chess.parseFen(input.key + ' 0 1')) !== input.key ||
      input.children.some(
        (child) =>
          chess.positionKey(chess.parseFen(child.fen)) !== child.key ||
          child.fen !== child.key + ' 0 1',
      )
    )
      throw new ChessProofStorageError('storage_state');
    if ((input.classification === 'branch') !== input.children.length > 0)
      throw new ChessProofStorageError('storage_state');
    await transaction(this.client, async () => {
      const source = (
        await this.client.query<{ expanded: boolean }>(
          'SELECT expanded FROM chess_proof_search_nodes WHERE work_id=$1 AND key=$2 FOR UPDATE',
          [this.id, input.key],
        )
      ).rows[0];
      if (!source || source.expanded)
        throw new ChessProofStorageError('storage_state');
      if (input.children.length) {
        // One legal position has a finite, small successor set. Preserve its
        // deterministic discovery order while avoiding a network round trip
        // per child. The node trigger still owns each FIFO sequence allocation.
        await this.client.query(
          `INSERT INTO chess_proof_search_nodes(work_id,key,fen,parent_key,parent_move)
           SELECT $1,item->>'key',item->>'fen',$2,item->>'move'
           FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY children(item,ordinal)
           ORDER BY ordinal ON CONFLICT(work_id,key) DO NOTHING`,
          [this.id, input.key, JSON.stringify(input.children)],
        );
        await this.client.query(
          `INSERT INTO chess_proof_search_edges(work_id,from_key,to_key)
           SELECT DISTINCT $1::uuid,$2::text,item->>'key'
           FROM jsonb_array_elements($3::jsonb) children(item) ON CONFLICT DO NOTHING`,
          [this.id, input.key, JSON.stringify(input.children)],
        );
      }
      await this.client.query(
        'UPDATE chess_proof_search_nodes SET expanded=true,classification=$3 WHERE work_id=$1 AND key=$2',
        [this.id, input.key, input.classification],
      );
    });
  }
  async beginExport(header: chess.ReachabilityStreamHeader): Promise<void> {
    this.available();
    const raw = JSON.stringify(header);
    const changed = await this.client.query(
      "UPDATE chess_proof_work SET stage='exporting',proof_kind=$2,header_json=$3,export_cursor='',chain_digest=$4 WHERE id=$1 AND stage='searching' RETURNING id",
      [this.id, header.kind, raw, chainSeed(raw)],
    );
    if (!changed.rowCount) throw new ChessProofStorageError('storage_state');
  }
  async appendChunk(bytes: Buffer, nextCursor: string): Promise<void> {
    this.available();
    const payload = Buffer.from(bytes),
      digest = hash(payload);
    if (
      !payload.length ||
      payload.length > CHUNK_BYTES ||
      payload.at(-1) !== 10
    )
      throw new ChessProofStorageError('storage_state');
    await transaction(this.client, async () => {
      const work = requireValue(
        (
          await this.client.query<WorkRow>(
            'SELECT * FROM chess_proof_work WHERE id=$1 FOR UPDATE',
            [this.id],
          )
        ).rows[0],
      );
      const previous = requireValue(work.chain_digest);
      await this.client.query(
        'INSERT INTO chess_proof_chunks(work_id,ordinal,payload,digest,previous_chain,chain_digest) VALUES($1,$2,$3,$4,$5,$6)',
        [
          this.id,
          work.chunk_count,
          payload,
          digest,
          previous,
          nextChain(previous, work.chunk_count, payload, digest),
        ],
      );
      await this.client.query(
        'UPDATE chess_proof_work SET export_cursor=$2 WHERE id=$1',
        [this.id, nextCursor],
      );
    });
  }
  async seal(): Promise<void> {
    this.available();
    if (
      !(
        await this.client.query(
          "UPDATE chess_proof_work SET stage='sealed' WHERE id=$1 AND stage='exporting' RETURNING id",
          [this.id],
        )
      ).rowCount
    )
      throw new ChessProofStorageError('storage_state');
  }
  async rejectInvalid(): Promise<void> {
    this.available();
    await this.client.query(
      "UPDATE chess_proof_work SET stage='rejected' WHERE id=$1",
      [this.id],
    );
  }
}

/** Fresh verifier namespace. Builder nodes/marks are never consulted. */
class PostgresProofWorkset implements chess.PrivateReachabilityWorkset {
  readonly runId = randomUUID();
  private begun = false;
  private current: Locator | undefined;
  private cachedChunk: ChunkRow | undefined;
  constructor(
    private readonly client: PoolClient,
    private readonly work: WorkRow,
  ) {}
  async create(): Promise<void> {
    await this.client.query(
      'INSERT INTO chess_proof_check_runs(id,work_id,root_key,kernel_engine,kernel_rules,format,proof_kind) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        this.runId,
        this.work.id,
        this.work.root_key,
        this.work.kernel_engine,
        this.work.kernel_rules,
        this.work.format,
        this.work.proof_kind,
      ],
    );
  }
  beginFresh(): void {
    if (this.begun) throw new ChessProofStorageError('storage_state');
    this.begun = true;
  }
  private ready(): void {
    if (!this.begun) throw new ChessProofStorageError('storage_state');
  }
  private async chunk(ordinal: string): Promise<ChunkRow> {
    if (this.cachedChunk?.ordinal === ordinal) return this.cachedChunk;
    const row = requireValue(
      (
        await this.client.query<ChunkRow>(
          'SELECT ordinal,payload,digest,previous_chain,chain_digest FROM chess_proof_chunks WHERE work_id=$1 AND ordinal=$2',
          [this.work.id, ordinal],
        )
      ).rows[0],
    );
    if (
      !hash(row.payload).equals(row.digest) ||
      !nextChain(row.previous_chain, ordinal, row.payload, row.digest).equals(
        row.chain_digest,
      )
    )
      throw new ChessProofStorageError('storage_state');
    this.cachedChunk = row;
    return row;
  }
  async *records(): AsyncGenerator<string> {
    let chain = chainSeed(requireValue(this.work.header_json)),
      bytes = 0n;
    for (let ordinal = 0n; ordinal < BigInt(this.work.chunk_count); ordinal++) {
      const row = await this.chunk(String(ordinal));
      if (!row.previous_chain.equals(chain) || row.payload.at(-1) !== 10)
        throw new ChessProofStorageError('storage_state');
      chain = row.chain_digest;
      bytes += BigInt(row.payload.length);
      let offset = 0;
      while (offset < row.payload.length) {
        const end = row.payload.indexOf(10, offset);
        if (end < 0 || end - offset > 262_144)
          throw new ChessProofStorageError('proof_invalid');
        const rawBytes = row.payload.subarray(offset, end),
          raw = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
        this.current = {
          ordinal: String(ordinal),
          offset,
          bytes: rawBytes.length,
          digest: hash(rawBytes),
          raw,
        };
        yield raw;
        offset = end + 1;
      }
    }
    if (
      !chain.equals(requireValue(this.work.chain_digest)) ||
      bytes !== BigInt(this.work.byte_count)
    )
      throw new ChessProofStorageError('storage_state');
    await this.client.query(
      "UPDATE chess_proof_check_runs SET stage='checking' WHERE id=$1 AND stage='registering'",
      [this.runId],
    );
  }
  async register(position: string, rawRecord: string): Promise<boolean> {
    this.ready();
    const location = requireValue(this.current);
    if (location.raw !== rawRecord)
      throw new ChessProofStorageError('storage_state');
    const registration = randomUUID();
    return transaction(this.client, async () => {
      const inserted = await this.client.query(
        'INSERT INTO chess_proof_check_nodes(run_id,work_id,key,registration_id,chunk_ordinal,record_offset,record_bytes,record_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id,key) DO NOTHING RETURNING key',
        [
          this.runId,
          this.work.id,
          position,
          registration,
          location.ordinal,
          location.offset,
          location.bytes,
          location.digest,
        ],
      );
      if (!inserted.rowCount) return false;
      await this.client.query(
        'UPDATE chess_proof_check_runs SET cursor_chunk=$2,cursor_offset=$3 WHERE id=$1',
        [this.runId, location.ordinal, location.offset + location.bytes + 1],
      );
      return true;
    });
  }
  async read(position: string): Promise<string | null> {
    this.ready();
    const location = (
      await this.client.query<{
        chunk_ordinal: string;
        record_offset: number;
        record_bytes: number;
        record_digest: Buffer;
      }>(
        'SELECT chunk_ordinal,record_offset,record_bytes,record_digest FROM chess_proof_check_nodes WHERE run_id=$1 AND key=$2',
        [this.runId, position],
      )
    ).rows[0];
    if (!location) return null;
    const row = await this.chunk(location.chunk_ordinal),
      bytes = row.payload.subarray(
        location.record_offset,
        location.record_offset + location.record_bytes,
      );
    if (
      bytes.length !== location.record_bytes ||
      !hash(bytes).equals(location.record_digest)
    )
      throw new ChessProofStorageError('storage_state');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  async enqueue(position: string): Promise<boolean> {
    this.ready();
    // True means membership, never "a queue row was newly inserted".
    return transaction(this.client, async () => {
      const row = (
        await this.client.query<{ mark: string; queued: boolean }>(
          'SELECT mark,queued FROM chess_proof_check_nodes WHERE run_id=$1 AND key=$2 FOR UPDATE',
          [this.runId, position],
        )
      ).rows[0];
      if (!row) return false;
      if (row.mark === 'unseen' && !row.queued)
        await this.client.query(
          'UPDATE chess_proof_check_nodes SET queued=true WHERE run_id=$1 AND key=$2',
          [this.runId, position],
        );
      return true;
    });
  }
  async dequeue(): Promise<string | null> {
    this.ready();
    return transaction(this.client, async () => {
      const row = (
        await this.client.query<{ key: string }>(
          'SELECT key FROM chess_proof_check_nodes WHERE run_id=$1 AND queued ORDER BY queue_seq LIMIT 1 FOR UPDATE',
          [this.runId],
        )
      ).rows[0];
      if (!row) return null;
      await this.client.query(
        'UPDATE chess_proof_check_nodes SET queued=false WHERE run_id=$1 AND key=$2',
        [this.runId, row.key],
      );
      return row.key;
    });
  }
  async claimVisited(position: string): Promise<'new' | 'seen' | 'missing'> {
    this.ready();
    const found = (
      await this.client.query<{ mark: string }>(
        'SELECT mark FROM chess_proof_check_nodes WHERE run_id=$1 AND key=$2',
        [this.runId, position],
      )
    ).rows[0];
    if (!found) return 'missing';
    if (found.mark !== 'unseen') return 'seen';
    const changed = await this.client.query(
      "UPDATE chess_proof_check_nodes SET mark='claimed' WHERE run_id=$1 AND key=$2 AND mark='unseen' RETURNING key",
      [this.runId, position],
    );
    return changed.rowCount ? 'new' : 'seen';
  }
  async checked(position: string): Promise<void> {
    this.ready();
    if (
      !(
        await this.client.query(
          "UPDATE chess_proof_check_nodes SET mark='checked' WHERE run_id=$1 AND key=$2 AND mark='claimed' RETURNING key",
          [this.runId, position],
        )
      ).rowCount
    )
      throw new ChessProofStorageError('storage_state');
  }
  async complete(
    summary: chess.VerifiedStreamingReachabilityDecision,
  ): Promise<void> {
    await this.client.query(
      "UPDATE chess_proof_check_runs SET stage='complete',verdict=$2,records=$3,nodes=$4,edges=$5,moves=$6 WHERE id=$1",
      [
        this.runId,
        summary.verdict,
        summary.counts.records,
        summary.counts.nodes,
        summary.counts.edges,
        summary.counts.moves,
      ],
    );
  }
  async failed(invalid: boolean): Promise<void> {
    await this.client.query(
      "UPDATE chess_proof_check_runs SET stage='failed',failure_kind=$2 WHERE id=$1 AND stage IN ('registering','checking')",
      [this.runId, invalid ? 'invalid-proof' : 'storage'],
    );
  }
}

/** Worker-owned durable proof storage. Verification/publication stay off the HTTP thread. */
export class ChessProofRepository {
  private readonly checked = new WeakMap<object, CheckBinding>();
  constructor(private readonly pool: Pool) {}

  /** Fair durable search/export, then independent checking, all in the caller's worker. */
  async solveAndBind(
    fen: string,
    options: { signal?: { readonly aborted: boolean } } = {},
  ): Promise<chess.CheckedArtifactBinding> {
    if (isMainThread) throw new ChessProofStorageError('worker_required');
    const abort = () => {
      if (options.signal?.aborted) {
        const error = new Error('Proof work aborted');
        error.name = 'AbortError';
        throw error;
      }
    };
    const workId = await this.withWork(fen, async (work) => {
      abort();
      let metadata = await work.metadata();
      if (metadata.stage === 'searching') {
        let mate = await work.mate(),
          pending = await work.nextPending();
        if (!mate && pending) {
          // A resumed durable frontier can also benefit from a fresh finite
          // positive probe; inserted hints preserve every existing first parent.
          const root = chess.expandReachabilityPosition(fen);
          if (root.kind === 'branch') {
            // A finite positive optimisation only. Failure never permits play or
            // asserts deadness: it proceeds to the persistent complete frontier.
            let hinted = false;
            for (const strategy of [
              'capture',
              'pawn-bait-before-capture',
            ] as const) {
              abort();
              const hint = chess.findMateReachabilityWitness(fen, {
                maxNodes: 30_000,
                maxPlies: 256,
                strategy,
              });
              if (hint.status === 'not-dead') {
                await work.storeWitnessHint(fen, hint.evidence);
                hinted = true;
                break;
              }
            }
            if (!hinted) {
              abort();
              // This bounded breadth-first probe retains at most 30,001 new
              // movement states. Only its short positive witness is imported;
              // a closed/pending probe never substitutes for durable checking.
              const budget = Math.min(
                64 * 1024 * 1024,
                getHeapStatistics().heap_size_limit / 2,
              );
              if (process.memoryUsage().heapUsed < budget) {
                const search = chess.createMateReachabilitySearch(fen);
                for (let edges = 0; edges < 30_000; edges += 256) {
                  abort();
                  if (process.memoryUsage().heapUsed >= budget) break;
                  const probe = search.advance(Math.min(256, 30_000 - edges));
                  if (
                    probe.status === 'not-dead' &&
                    probe.evidence.moves.length <= 256
                  )
                    await work.storeWitnessHint(fen, probe.evidence);
                  if (probe.status !== 'pending') break;
                }
              }
            }
          }
        }
        mate = await work.mate();
        while (!mate && (pending = await work.nextPending())) {
          abort();
          const expanded = chess.expandReachabilityPosition(pending.fen);
          if (
            expanded.kernelEngineVersion !== metadata.kernel_engine ||
            expanded.kernelRulesVersion !== metadata.kernel_rules ||
            expanded.position !== pending.key
          )
            throw new ChessProofStorageError('storage_state');
          await work.commitExpansion({
            key: expanded.position,
            classification:
              expanded.kind === 'mate'
                ? 'mate'
                : expanded.kind === 'branch'
                  ? 'branch'
                  : (expanded.node.leaf as Classification),
            children:
              expanded.kind === 'branch'
                ? expanded.successors.map((child) => ({
                    key: child.position,
                    fen: child.fen,
                    move: chess.uci(child.move),
                  }))
                : [],
          });
          mate = await work.mate();
        }
        let header: chess.ReachabilityStreamHeader;
        if (mate) {
          await work.beginWitness(mate.key);
          while (!(await work.metadata()).witness_ready) {
            abort();
            await work.witnessStep();
          }
          const ending = chess.expandReachabilityPosition(mate.fen);
          if (ending.kind !== 'mate')
            throw new ChessProofStorageError('storage_state');
          header = {
            format: chess.REACHABILITY_STREAM_FORMAT,
            kind: 'reachable-mate',
            root: metadata.root_key,
            engineVersion: chess.ENGINE_VERSION,
            rulesVersion: chess.RULES_VERSION,
            winner: ending.winner,
          };
        } else {
          header = {
            format: chess.REACHABILITY_STREAM_FORMAT,
            kind: 'closed-movement-graph',
            root: metadata.root_key,
            engineVersion: chess.ENGINE_VERSION,
            rulesVersion: chess.RULES_VERSION,
          };
        }
        await work.beginExport(header);
        metadata = await work.metadata();
      }
      if (metadata.stage === 'exporting') {
        let cursor = requireValue(metadata.export_cursor),
          finished = false;
        while (!finished) {
          abort();
          let chunk = '',
            records = 0,
            nextCursor = cursor;
          while (records < 256) {
            const next = await work.exportRecord(
              requireValue(metadata.proof_kind),
              nextCursor,
            );
            if (!next) {
              finished = true;
              break;
            }
            const line = next.raw + '\n';
            if (Buffer.byteLength(line) > CHUNK_BYTES)
              throw new ChessProofStorageError('storage_state');
            if (Buffer.byteLength(chunk + line) > CHUNK_BYTES) break;
            chunk += line;
            nextCursor = next.cursor;
            records++;
          }
          if (chunk) {
            await work.appendChunk(Buffer.from(chunk), nextCursor);
            cursor = nextCursor;
          }
        }
        await work.seal();
      } else if (metadata.stage !== 'sealed')
        throw new ChessProofStorageError('storage_state');
      return work.id;
    });
    abort();
    try {
      const token = await this.verifySealed(workId, fen, options.signal);
      return await this.checkedBinding(token);
    } catch (error) {
      if (
        error instanceof ChessProofStorageError &&
        error.code === 'proof_invalid'
      ) {
        await this.existing(workId, async (client, work) => {
          if (
            work.stage === 'sealed' &&
            !(
              await client.query(
                'SELECT 1 FROM chess_proof_artifacts WHERE work_id=$1',
                [workId],
              )
            ).rowCount
          )
            await client.query(
              "UPDATE chess_proof_work SET stage='rejected' WHERE id=$1",
              [workId],
            );
        });
      }
      throw error;
    }
  }
  private async locked<T>(
    question: Pick<
      WorkRow,
      'root_key' | 'kernel_engine' | 'kernel_rules' | 'format'
    >,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect(),
      key = questionKey(question);
    try {
      // Session-scoped proof-only lock; deliberately NO BEGIN around CPU/I/O work.
      await client.query(
        'SELECT pg_advisory_lock(hashtextextended(current_schema() || $1,0))',
        [key],
      );
      return await run(client);
    } finally {
      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended(current_schema() || $1,0))',
          [key],
        );
      } finally {
        client.release();
      }
    }
  }
  async withWork<T>(
    fen: string,
    run: (work: ChessProofWork) => Promise<T>,
  ): Promise<T> {
    const root = chess.positionKey(chess.parseFen(fen)),
      question = {
        root_key: root,
        kernel_engine: chess.ENGINE_VERSION,
        kernel_rules: chess.RULES_VERSION,
        format: chess.REACHABILITY_STREAM_FORMAT,
      };
    return this.locked(question, async (client) => {
      const id = await transaction(client, async () => {
        const found = (
          await client.query<WorkRow>(
            "SELECT * FROM chess_proof_work WHERE root_key=$1 AND kernel_engine=$2 AND kernel_rules=$3 AND format=$4 AND stage<>'rejected'",
            Object.values(question),
          )
        ).rows[0];
        if (found) return found.id;
        const attempt = (
            await client.query<{ next: string }>(
              'SELECT (coalesce(max(attempt_no),0)+1)::text AS next FROM chess_proof_work WHERE root_key=$1 AND kernel_engine=$2 AND kernel_rules=$3 AND format=$4',
              Object.values(question),
            )
          ).rows[0]!.next,
          created = randomUUID();
        await client.query(
          'INSERT INTO chess_proof_work(id,root_key,kernel_engine,kernel_rules,format,attempt_no) VALUES($1,$2,$3,$4,$5,$6)',
          [created, ...Object.values(question), attempt],
        );
        await client.query(
          'INSERT INTO chess_proof_search_nodes(work_id,key,fen) VALUES($1,$2,$3)',
          [created, root, root + ' 0 1'],
        );
        return created;
      });
      const work = new ChessProofWork(client, id);
      try {
        return await run(work);
      } finally {
        work.release();
      }
    });
  }
  private async existing<T>(
    id: string,
    run: (client: PoolClient, work: WorkRow) => Promise<T>,
  ): Promise<T> {
    const source = requireValue(
      (
        await this.pool.query<WorkRow>(
          'SELECT * FROM chess_proof_work WHERE id=$1',
          [id],
        )
      ).rows[0],
    );
    return this.locked(source, async (client) =>
      run(
        client,
        requireValue(
          (
            await client.query<WorkRow>(
              'SELECT * FROM chess_proof_work WHERE id=$1',
              [id],
            )
          ).rows[0],
        ),
      ),
    );
  }
  async verifySealed(
    id: string,
    fen: string,
    signal?: { readonly aborted: boolean },
  ): Promise<chess.VerifiedStreamingReachabilityDecision> {
    if (isMainThread) throw new ChessProofStorageError('worker_required');
    return this.existing(id, async (client, work) => {
      if (
        work.stage !== 'sealed' ||
        chess.positionKey(chess.parseFen(fen)) !== work.root_key
      )
        throw new ChessProofStorageError('storage_state');
      const workset = new PostgresProofWorkset(client, work);
      await workset.create();
      try {
        const summary = await chess.verifyStreamingReachability(
          fen,
          requireValue(work.header_json),
          workset.records(),
          { privateWorkset: workset, ...(signal ? { signal } : {}) },
        );
        if (!chess.isVerifiedStreamingReachabilityDecision(summary)) {
          await workset.failed(true);
          throw new ChessProofStorageError('proof_invalid');
        }
        await workset.complete(summary);
        this.checked.set(summary, { work, runId: workset.runId, summary });
        return summary;
      } catch (error) {
        await workset.failed(
          error instanceof ChessProofStorageError &&
            error.code === 'proof_invalid',
        );
        throw error;
      }
    });
  }
  async publishChecked(
    token: unknown,
  ): Promise<CheckedProofArtifactDescriptor> {
    if (isMainThread) throw new ChessProofStorageError('worker_required');
    if (!chess.isVerifiedStreamingReachabilityDecision(token))
      throw new ChessProofStorageError('proof_invalid');
    const proof = this.checked.get(token);
    if (!proof) throw new ChessProofStorageError('proof_invalid');
    return this.existing(proof.work.id, async (client, work) => {
      if (
        work.stage !== 'sealed' ||
        work.header_json !== proof.work.header_json ||
        work.root_key !== proof.summary.root ||
        work.kernel_engine !== proof.summary.engineVersion ||
        work.kernel_rules !== proof.summary.rulesVersion ||
        work.format !== proof.summary.format ||
        work.chunk_count !== proof.work.chunk_count ||
        work.byte_count !== proof.work.byte_count ||
        !requireValue(work.chain_digest).equals(
          requireValue(proof.work.chain_digest),
        )
      )
        throw new ChessProofStorageError('storage_state');
      const summary = proof.summary,
        manifest = Buffer.from(
          JSON.stringify({
            format: ARTIFACT_FORMAT,
            root: work.root_key,
            kernelEngineVersion: work.kernel_engine,
            kernelRulesVersion: work.kernel_rules,
            streamFormat: work.format,
            kind: summary.kind,
            verdict: summary.verdict,
            headerSha256: hash(
              Buffer.from(requireValue(work.header_json)),
            ).toString('hex'),
            chunkChainSha256: requireValue(work.chain_digest).toString('hex'),
            chunks: work.chunk_count,
            bytes: work.byte_count,
            ...summary.counts,
          }),
        ),
        digest = hash(manifest);
      const prior = (
        await client.query<{ manifest_digest: Buffer }>(
          'SELECT manifest_digest FROM chess_proof_artifacts WHERE work_id=$1',
          [work.id],
        )
      ).rows[0];
      const descriptor: CheckedProofArtifactDescriptor = {
        artifactId: digest.toString('hex'),
        root: summary.root,
        kernelEngineVersion: summary.engineVersion,
        kernelRulesVersion: summary.rulesVersion,
        format: summary.format,
      };
      if (prior) {
        if (!prior.manifest_digest.equals(digest))
          throw new ChessProofStorageError('storage_state');
        return Object.freeze(descriptor);
      }
      await client.query(
        'INSERT INTO chess_proof_artifacts(manifest_digest,manifest,work_id,check_run_id,root_key,kernel_engine,kernel_rules,format,proof_kind,verdict,chain_digest,chunk_count,byte_count,records,nodes,edges,moves) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
        [
          digest,
          manifest,
          work.id,
          proof.runId,
          work.root_key,
          work.kernel_engine,
          work.kernel_rules,
          work.format,
          summary.kind,
          summary.verdict,
          work.chain_digest,
          work.chunk_count,
          work.byte_count,
          summary.counts.records,
          summary.counts.nodes,
          summary.counts.edges,
          summary.counts.moves,
        ],
      );
      return Object.freeze(descriptor);
    });
  }

  /** Cold replay re-verifies exact published bytes; metadata is never a verdict. */
  async verifyArtifact(
    artifactId: string,
    fen: string,
  ): Promise<chess.VerifiedStreamingReachabilityDecision> {
    if (isMainThread) throw new ChessProofStorageError('worker_required');
    if (!/^[a-f0-9]{64}$/.test(artifactId))
      throw new ChessProofStorageError('storage_state');
    const row = requireValue(
      (
        await this.pool.query<{ work_id: string }>(
          'SELECT work_id FROM chess_proof_artifacts WHERE manifest_digest=$1',
          [Buffer.from(artifactId, 'hex')],
        )
      ).rows[0],
    );
    const token = await this.verifySealed(row.work_id, fen),
      descriptor = await this.publishChecked(token);
    if (descriptor.artifactId !== artifactId)
      throw new ChessProofStorageError('storage_state');
    return token;
  }

  /** Only this repository constructs a binding from its exact checked transport. */
  async checkedBinding(token: unknown): Promise<chess.CheckedArtifactBinding> {
    const descriptor = await this.publishChecked(token),
      result = chess.bindVerifiedArtifact(token, descriptor);
    if (!result.ok) throw new ChessProofStorageError('proof_invalid');
    return result.value;
  }
}
