export * from './types.js';
export { ChessEngineError } from './errors.js';
export {
  createGame,
  createAnalysisGame,
  applyAction,
  getLegalActions,
  getDrawClaims,
  getObservation,
  validateState,
  restoreState,
  serializeState,
  replay,
  isGameOver,
  isPlayStopped,
  prepareStrictGame,
  prepareStrictAction,
  finishStrictCandidate,
  restoreStrictState,
  replayStrict,
  getStrictObservation,
  bindVerifiedArtifact,
  prepareArtifactGame,
  prepareArtifactAction,
  finishArtifactCandidate,
  restoreArtifactState,
  replayArtifact,
  getArtifactObservation,
  adjudicate,
  proveDeadPosition,
  resolveResignationWithWitness,
} from './engine.js';
export { chooseBotAction, nextRandom } from './bot.js';
export {
  analyzeKingCorridor,
  type KingCorridorCertificate,
} from './joint-kings.js';
export {
  analyzeMatePossibility,
  analyzeDeadPosition,
  validateMateWitness,
} from './proofs.js';
/** Pure analysis/diagnostic helpers. They do not alter a game or authorize actions. */
export { parseFen, toFen, positionKey, perft, uci } from './position.js';
export {
  analyzeLockedPosition,
  type LockedPositionCertificate,
  type LockedPieceRegion,
  type LockedBlocker,
  type LockedEscapeSet,
  type LockedCastlingExclusion,
} from './locked.js';
export {
  analyzeTemporalPosition,
  type TemporalPositionCertificate,
  type TemporalPawnBound,
  type TemporalPieceRegion,
  type TemporalPieceState,
  type TemporalCastlingTransition,
} from './temporal.js';
export {
  createMateReachabilitySearch,
  expandReachabilityPosition,
  findMateReachabilityWitness,
  solveMateReachabilityExactly,
  solveMateReachability,
  verifyReachabilityEvidence,
  verifyReachabilityDecision,
  type ReachabilityLimits,
  type ReachabilityMetrics,
  type ReachabilityProofNode,
  type ClosedReachabilityProof,
  type ReachableMateWitness,
  type ReachabilityEvidence,
  type MateReachabilityResult,
  type MateReachabilityProgress,
  type MateReachabilitySearch,
  type MateWitnessSearchOptions,
  type MateWitnessSearchResult,
  type ExactMateReachabilityResult,
  type ReachabilityDecisionVerification,
  type ReachabilityExpansion,
} from './reachability.js';
export {
  verifyStreamingReachability,
  isVerifiedStreamingReachabilityDecision,
  REACHABILITY_STREAM_FORMAT,
  REACHABILITY_STREAM_MAX_RECORD_CHARS,
  type ReachabilityStreamHeader,
  type PrivateReachabilityWorkset,
  type StreamingReachabilityOptions,
  type StreamingReachabilityVerification,
  type VerifiedStreamingReachabilityDecision,
} from './streaming-reachability.js';
