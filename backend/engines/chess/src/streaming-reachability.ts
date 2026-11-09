/** Bounded-record proof verification; no search or global proof-size cutoff. */
import type { Color } from './types.js';
import { ENGINE_VERSION, RULES_VERSION } from './types.js';
import { keys, object } from './errors.js';
import {
  advance,
  findLegalMove,
  inCheck,
  legalBoardMoves,
  opposite,
  parseFen,
  parseMove,
  positionKey,
} from './position.js';
import {
  checkReachabilityProofNode,
  reachabilityLeafKind,
} from './reachability.js';

export const REACHABILITY_STREAM_FORMAT =
  'skillbetting.chess.reachability-stream.v1' as const;
export const REACHABILITY_STREAM_MAX_RECORD_CHARS = 65_536;
export type ReachabilityStreamHeader = {
  readonly format: typeof REACHABILITY_STREAM_FORMAT;
  readonly root: string;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly rulesVersion: typeof RULES_VERSION;
} & (
  | { readonly kind: 'closed-movement-graph' }
  | { readonly kind: 'reachable-mate'; readonly winner: Color }
);
type Stored<T> = T | Promise<T>;
/**
 * TRUSTED SERVER-PRIVATE persistence contract, never player-supplied callbacks.
 * Each verification owns a fresh exclusive namespace, separate from all search
 * builder rows/marks/counts. register is atomic/unique and read preserves EXACT
 * registered bytes (an adapter may use immutable chunk locators plus digests).
 * Visited/frontier state belongs only to this checker. enqueue must return false
 * for absent membership; it may deduplicate queued/visited members. dequeue must
 * not lose queued unvisited members. claimVisited is atomic and monotonic.
 * Storage failures throw, not null/false masquerading as a mathematical answer.
 * The caller owns cleanup after success/failure; a used namespace cannot reopen.
 */
export interface PrivateReachabilityWorkset {
  beginFresh(): Stored<void>;
  register(position: string, rawRecord: string): Stored<boolean>;
  read(position: string): Stored<string | null>;
  claimVisited(position: string): Stored<'new' | 'seen' | 'missing'>;
  enqueue(position: string): Stored<boolean>;
  dequeue(): Stored<string | null>;
  /** Optional durable bookkeeping after math and every successor membership check. */
  checked?(position: string): Stored<void>;
}
export interface StreamingReachabilityOptions {
  readonly privateWorkset?: PrivateReachabilityWorkset;
  /** I/O adapters also need bounded/cancellable operations; polled between awaits. */
  readonly signal?: { readonly aborted: boolean };
}
export type StreamingReachabilityVerification =
  | {
      readonly valid: true;
      readonly verdict: 'dead' | 'not-dead';
      readonly format: typeof REACHABILITY_STREAM_FORMAT;
      readonly kind: ReachabilityStreamHeader['kind'];
      readonly root: string;
      readonly engineVersion: typeof ENGINE_VERSION;
      readonly rulesVersion: typeof RULES_VERSION;
      /** Engine-owned decimal counts, excluding the header. No JSON BigInt coercion. */
      readonly counts: {
        readonly records: string;
        readonly nodes: string;
        readonly edges: string;
        readonly moves: string;
      };
    }
  | { readonly valid: false; readonly reason: string };
export type VerifiedStreamingReachabilityDecision = Extract<
  StreamingReachabilityVerification,
  { readonly valid: true }
>;
const verifiedDecisions = new WeakSet<object>();
/** Same-module/worker proof provenance only, never player/game-result authority. */
export function isVerifiedStreamingReachabilityDecision(
  value: unknown,
): value is VerifiedStreamingReachabilityDecision {
  return (
    value !== null && typeof value === 'object' && verifiedDecisions.has(value)
  );
}
class InvalidStreamProof extends Error {}
function invalid(message: string): never {
  throw new InvalidStreamProof(message);
}
function proofData<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid proof record.');
  }
}
function parseRecord(
  raw: string,
  max = REACHABILITY_STREAM_MAX_RECORD_CHARS,
): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length > max)
    invalid('Proof record exceeds its bounded framing limit.');
  return proofData(() => object(JSON.parse(raw) as unknown, 'INVALID_PROOF'));
}
function canonicalNodeRecord(raw: string): {
  readonly position: string;
  readonly record: Record<string, unknown>;
} {
  const record = parseRecord(raw);
  proofData(() =>
    keys(record, ['position', 'leaf', 'successors'], 'INVALID_PROOF'),
  );
  if (
    typeof record.position !== 'string' ||
    record.position.length > 120 ||
    !Array.isArray(record.successors) ||
    record.successors.length > 256
  )
    invalid('Invalid graph record.');
  const position = record.position;
  if (proofData(() => positionKey(parseFen(position + ' 0 1'))) !== position)
    invalid('Noncanonical graph position.');
  return { position, record };
}
function checkAbort(signal: StreamingReachabilityOptions['signal']): void {
  if (signal?.aborted) {
    const error = new Error('Reachability verification aborted.');
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * Header and body records are separately framed JSON strings. Readers must bound
 * their input chunks/line buffering too. Valid graph nodes are independently
 * re-expanded from the root using a fresh private checker workset; builder flags
 * and counts never enter the proof. Invalid proof returns no verdict; stream,
 * storage and cancellation exceptions propagate with no decision. This helper
 * does not authorise a game action or clear any release/architecture hold.
 */
export async function verifyStreamingReachability(
  fen: string,
  headerJson: string,
  records: AsyncIterable<string>,
  options: StreamingReachabilityOptions = {},
): Promise<StreamingReachabilityVerification> {
  try {
    checkAbort(options.signal);
    const header = parseRecord(headerJson, 2048),
      initial = proofData(() => parseFen(fen)),
      root = positionKey(initial);
    if (
      header.format !== REACHABILITY_STREAM_FORMAT ||
      header.engineVersion !== ENGINE_VERSION ||
      header.rulesVersion !== RULES_VERSION ||
      header.root !== root ||
      (header.kind !== 'closed-movement-graph' &&
        header.kind !== 'reachable-mate')
    )
      invalid('Streaming proof format/root/kernel binding mismatch.');
    proofData(() =>
      keys(
        header,
        [
          'format',
          'kind',
          'root',
          'engineVersion',
          'rulesVersion',
          ...(header.kind === 'reachable-mate' ? ['winner'] : []),
        ],
        'INVALID_PROOF',
      ),
    );
    let recordCount = 0n,
      nodeCount = 0n,
      edgeCount = 0n,
      moveCount = 0n;
    if (header.kind === 'reachable-mate') {
      if (header.winner !== 'white' && header.winner !== 'black')
        invalid('Invalid witness winner.');
      let position = { ...initial, halfmove: 0, fullmove: 1 };
      for await (const raw of records) {
        checkAbort(options.signal);
        const spec = proofData(() => parseMove(parseRecord(raw))),
          moves = legalBoardMoves(position);
        if (
          !moves.length ||
          reachabilityLeafKind(position, moves, true) !== null
        )
          invalid('Witness continues past an ending.');
        position = proofData(() => ({
          ...advance(position, findLegalMove(position, spec, moves)),
          halfmove: 0,
          fullmove: 1,
        }));
        recordCount++;
        moveCount++;
        edgeCount++;
        checkAbort(options.signal);
      }
      if (
        legalBoardMoves(position).length ||
        !inCheck(position) ||
        opposite(position.turn) !== header.winner
      )
        invalid('Witness does not end in the stated mate.');
    } else {
      const workset = options.privateWorkset;
      if (!workset)
        throw new Error('A fresh server-private checker workset is required.');
      await workset.beginFresh();
      checkAbort(options.signal);
      for await (const raw of records) {
        checkAbort(options.signal);
        const node = canonicalNodeRecord(raw),
          added = await workset.register(node.position, raw);
        checkAbort(options.signal);
        if (added === false) invalid('Duplicate proof node.');
        if (added !== true)
          throw new Error('Private workset violated membership registration.');
        recordCount++;
        nodeCount++;
      }
      checkAbort(options.signal);
      if (!nodeCount) invalid('Empty proof graph.');
      const enqueue = async (position: string): Promise<void> => {
        checkAbort(options.signal);
        const present = await workset.enqueue(position);
        checkAbort(options.signal);
        if (present === false) invalid('Missing proof node or open graph.');
        if (present !== true)
          throw new Error('Private workset violated frontier membership.');
      };
      await enqueue(root);
      let reached = 0n;
      for (;;) {
        checkAbort(options.signal);
        const position = await workset.dequeue();
        checkAbort(options.signal);
        if (position === null) break;
        if (typeof position !== 'string' || position.length > 120)
          throw new Error('Invalid private frontier entry.');
        const mark = await workset.claimVisited(position);
        checkAbort(options.signal);
        if (mark === 'seen') continue;
        if (mark !== 'new')
          throw new Error(
            'Private workset lost registered frontier membership.',
          );
        const raw = await workset.read(position);
        checkAbort(options.signal);
        if (raw === null)
          throw new Error('Private workset lost a registered record.');
        const stored = canonicalNodeRecord(raw);
        if (stored.position !== position)
          invalid('Stored record position mismatch.');
        const checked = proofData(() =>
          checkReachabilityProofNode(stored.record),
        );
        for (const successor of checked.node.successors)
          await enqueue(successor);
        checkAbort(options.signal);
        if (workset.checked) {
          await workset.checked(position);
          checkAbort(options.signal);
        }
        reached++;
        edgeCount += BigInt(checked.edges);
      }
      if (reached !== nodeCount) invalid('Unreachable extra proof nodes.');
    }
    checkAbort(options.signal);
    const checked: VerifiedStreamingReachabilityDecision = Object.freeze({
      valid: true,
      verdict: header.kind === 'reachable-mate' ? 'not-dead' : 'dead',
      format: REACHABILITY_STREAM_FORMAT,
      kind: header.kind,
      root,
      engineVersion: ENGINE_VERSION,
      rulesVersion: RULES_VERSION,
      counts: Object.freeze({
        records: recordCount.toString(),
        nodes: nodeCount.toString(),
        edges: edgeCount.toString(),
        moves: moveCount.toString(),
      }),
    });
    verifiedDecisions.add(checked);
    return checked;
  } catch (error) {
    if (!(error instanceof InvalidStreamProof)) throw error;
    return Object.freeze({ valid: false, reason: error.message });
  }
}
