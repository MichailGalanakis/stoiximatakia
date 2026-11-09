import {
  createGame,
  applyAction,
  getObservation,
  chooseBotAction,
  type PlayerAction,
  type ChessState,
} from '../dist/esm/index.js';
const created = createGame({ players: { white: 'alice', black: 'bob' } });
const action: PlayerAction = { type: 'move', from: 'e2', to: 'e4' };
if (created.ok) {
  const state: ChessState = created.state;
  const moved = applyAction(state, 'alice', action, state.revision);
  if (moved.ok) {
    const view = getObservation(moved.state, 'bob');
    if (view.ok)
      chooseBotAction(view.value, { strategy: 'random', randomState: 42 });
  }
  // @ts-expect-error State snapshots are readonly.
  state.fen = 'not allowed';
}
// @ts-expect-error Only exactly two explicitly colored participant ids are configured.
createGame({ players: ['alice', 'bob'] });
// @ts-expect-error Clocks are deliberately outside this game package.
createGame({ players: { white: 'a', black: 'b' }, clock: '5+3' });
const bad: PlayerAction = {
  type: 'move',
  from: 'a7',
  to: 'a8',
  // @ts-expect-error A king is not a legal promotion choice.
  promotion: 'k',
};
void bad;

import {
  verifyStreamingReachability,
  isVerifiedStreamingReachabilityDecision,
  REACHABILITY_STREAM_FORMAT,
  type ReachabilityStreamHeader,
  type PrivateReachabilityWorkset,
} from '../dist/esm/index.js';
const streamHeader: ReachabilityStreamHeader = {
  format: REACHABILITY_STREAM_FORMAT,
  kind: 'closed-movement-graph',
  engineVersion: '0.3.0',
  rulesVersion: 'skillbetting.chess.fide-2023.v2',
  root: '',
};
async function checkStreamingContract(workset: PrivateReachabilityWorkset) {
  const checked = await verifyStreamingReachability(
    '',
    JSON.stringify(streamHeader),
    (async function* () {
      yield '{}';
    })(),
    { privateWorkset: workset },
  );
  if (checked.valid && isVerifiedStreamingReachabilityDecision(checked)) {
    const count: string = checked.counts.records;
    void count;
    // @ts-expect-error Checked streaming count bindings are immutable.
    checked.counts.records = 'untrusted';
  }
}
void checkStreamingContract;

import {
  prepareArtifactGame,
  finishArtifactCandidate,
  restoreArtifactState,
  getArtifactObservation,
  expandReachabilityPosition,
  type ArtifactDescriptor,
  type CheckedArtifactBinding,
} from '../dist/esm/index.js';
const artifactPrepared = prepareArtifactGame({
  players: { white: 'a', black: 'b' },
});
function artifactContract(
  binding: CheckedArtifactBinding,
  descriptor: ArtifactDescriptor,
) {
  if (artifactPrepared.ok) {
    const finished = finishArtifactCandidate(artifactPrepared.value, binding);
    // @ts-expect-error A transport descriptor is not an engine-checked binding.
    finishArtifactCandidate(artifactPrepared.value, descriptor);
    if (finished.ok) {
      restoreArtifactState(finished.state, [binding]);
      getArtifactObservation(finished.state, 'a', [binding]);
      // @ts-expect-error Artifact profile snapshots cannot enter the legacy engine.
      applyAction(finished.state, 'a', { type: 'offer-draw' });
      // @ts-expect-error Decision refs contain no caller-supplied verdict.
      finished.state.decisions[0].verdict;
    }
  }
  const expansion = expandReachabilityPosition('');
  if (expansion.kind === 'mate') {
    // @ts-expect-error A mate cannot be exported as a dead-graph node.
    expansion.node;
  }
}
void artifactContract;

import {
  prepareStrictGame,
  prepareStrictAction,
  finishStrictCandidate,
  getStrictObservation,
  type StrictChessState,
  type StrictChessCandidate,
} from '../dist/esm/index.js';
const strictPrepared = prepareStrictGame({
  players: { white: 'a', black: 'b' },
});
if (strictPrepared.ok) {
  const candidate: StrictChessCandidate = strictPrepared.value;
  // @ts-expect-error A preparation summary cannot be edited into an accepted decision.
  candidate.needsEvidence = false;
  const finished = finishStrictCandidate(candidate);
  if (finished.ok) {
    const state: StrictChessState = finished.state;
    const strictView = getStrictObservation(state, 'a');
    if (strictView.ok) {
      const detection: 'required-verified-evidence' =
        strictView.value.conformance.automaticDeadPositionDetection;
      const unproved: false = strictView.value.conformance.unprovedContinuation;
      void detection;
      void unproved;
    }
    prepareStrictAction(state, 'a', { type: 'offer-draw' }, state.revision);
    // @ts-expect-error Strict profile snapshots are not legacy engine snapshots.
    applyAction(state, 'a', { type: 'offer-draw' });
    // @ts-expect-error Retained decision receipts are readonly.
    state.decisions.push(state.decisions[0]);
  }
}

import {
  createMateReachabilitySearch,
  findMateReachabilityWitness,
  solveMateReachabilityExactly,
  solveMateReachability,
  verifyReachabilityEvidence,
  verifyReachabilityDecision,
} from '../dist/esm/index.js';
const retained = createMateReachabilitySearch(
  created.ok ? created.state.fen : '',
);
const progress = retained.advance(1);
const exact = solveMateReachabilityExactly(created.ok ? created.state.fen : '');
if (exact.status === 'dead') {
  const nodes: readonly unknown[] = exact.evidence.nodes;
  void nodes;
}
const guided = findMateReachabilityWitness(
  created.ok ? created.state.fen : '',
  { maxNodes: 1, strategy: 'pawn-bait-before-capture' },
);
if (guided.status === 'unknown') {
  const noEvidence: null = guided.evidence;
  void noEvidence;
}
if (progress.status === 'pending') {
  const noEvidence: null = progress.evidence;
  void noEvidence;
}
// @ts-expect-error Retained search operations are readonly.
retained.advance = () => progress;
const reachability = solveMateReachability(
  created.ok ? created.state.fen : '',
  { maxPositions: 64 },
);
if (reachability.status === 'dead') {
  const decision = verifyReachabilityDecision(
    reachability.evidence.root + ' 0 1',
    reachability.evidence,
  );
  if (decision.valid) {
    const verdict: 'dead' | 'not-dead' = decision.verdict;
    void verdict;
    // @ts-expect-error Verified decision bindings are readonly.
    decision.root = 'untrusted';
  }
  verifyReachabilityEvidence(
    reachability.evidence.root + ' 0 1',
    reachability.evidence,
  );
  // @ts-expect-error Proof graph nodes are readonly consumer data.
  reachability.evidence.nodes.push({
    position: '',
    leaf: null,
    successors: [],
  });
}

import {
  analyzeLockedPosition,
  type LockedPositionCertificate,
} from '../dist/esm/index.js';
const certificate: LockedPositionCertificate | null = analyzeLockedPosition(
  '7k/8/8/p1p1p1p1/P1P1P1P1/8/8/K7 w - - 0 1',
);
if (certificate) {
  const kind: LockedPositionCertificate['kind'] = certificate.kind;
  void kind;
  // @ts-expect-error Diagnostic certificate shapes are readonly for consumers.
  certificate.pawns.push('a1');
}

import type { LockedEscapeSet } from '../dist/esm/index.js';
if (certificate) {
  const sets: readonly LockedEscapeSet[] = certificate.escapeSets;
  for (const entry of sets) {
    const maximum: number = entry.maxOccupants;
    void maximum;
    // @ts-expect-error Escape-set alternatives are readonly for consumers.
    entry.candidates.push('a1');
  }
}

import type { LockedCastlingExclusion, Square } from '../dist/esm/index.js';
if (certificate) {
  const ep: Square | null = certificate.unusableEnPassant;
  const exclusions: readonly LockedCastlingExclusion[] =
    certificate.castlingExclusions;
  void ep;
  for (const exclusion of exclusions) {
    const right: 'K' | 'Q' | 'k' | 'q' = exclusion.right;
    void right;
    // @ts-expect-error Castling proof exclusions are readonly diagnostic data.
    exclusion.blockers.push('b1');
    // @ts-expect-error Guaranteed attacked paths are readonly diagnostic data.
    exclusion.attackedKingPath.push('d1');
  }
  // @ts-expect-error A diagnostic certificate cannot be edited through its contract.
  certificate.unusableEnPassant = 'a3';
}

import {
  analyzeTemporalPosition,
  type TemporalPositionCertificate,
  type TemporalPieceRegion,
  type TemporalPawnBound,
  type TemporalPieceState,
} from '../dist/esm/index.js';
const temporal: TemporalPositionCertificate | null = analyzeTemporalPosition(
  'kb6/p1p5/P1P5/5pP1/8/8/P1P2P1P/4K3 w - - 0 1',
);
if (temporal) {
  const kind: 'finite-pawn-tempo' = temporal.kind;
  const clock: 'white' | 'black' = temporal.clockSide;
  const horizon: number = temporal.maxOtherMoves;
  const bounds: readonly TemporalPawnBound[] = temporal.pawnBounds;
  const regions: readonly TemporalPieceRegion[] = temporal.regions;
  const states: readonly TemporalPieceState[] = regions[0].states;
  const minimum: number = states[0].minMoves;
  void kind;
  void clock;
  void horizon;
  void bounds;
  void minimum;
  // @ts-expect-error The finite move horizon is immutable diagnostic data.
  temporal.maxOtherMoves = 999;
  // @ts-expect-error Original-piece regions preserve readonly promotion identities.
  temporal.regions.push(regions[0]);
  // @ts-expect-error A typed promotion state cannot be changed through the API.
  states[0].minMoves = 0;
}

import type { TemporalCastlingTransition } from '../dist/esm/index.js';
if (temporal) {
  const castles: readonly TemporalCastlingTransition[] =
    temporal.castlingTransitions;
  const exclusions: readonly LockedCastlingExclusion[] =
    temporal.clockCastlingExclusions;
  void exclusions;
  for (const castle of castles) {
    const king: Square = castle.kingTo,
      rook: Square = castle.rookTo;
    const turns: number = castle.minMoves;
    void king;
    void rook;
    void turns;
    // @ts-expect-error A compound relocation diagnostic is readonly.
    castle.rookTo = 'a1';
  }
  // @ts-expect-error Castling diagnostics cannot be appended through the API.
  temporal.castlingTransitions.push(castles[0]);
  // @ts-expect-error Clock-side invariant exclusions are readonly as well.
  temporal.clockCastlingExclusions.push(exclusions[0]);
}
