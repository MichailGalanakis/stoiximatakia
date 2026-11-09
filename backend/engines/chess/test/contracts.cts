import engine = require('../dist/cjs/index.js');
const created = engine.createGame({ players: { white: 'a', black: 'b' } });
if (created.ok) {
  const result: engine.TransitionResult = engine.applyAction(
    created.state,
    'a',
    { type: 'move', from: 'e2', to: 'e4' },
    0,
  );
  void result;
}
const certificate: engine.LockedPositionCertificate | null =
  engine.analyzeLockedPosition('7k/8/8/p1p1p1p1/P1P1P1P1/8/8/K7 w - - 0 1');
void certificate;

if (certificate) {
  const exclusions: readonly engine.LockedCastlingExclusion[] =
    certificate.castlingExclusions;
  const ep: engine.Square | null = certificate.unusableEnPassant;
  void exclusions;
  void ep;
  // @ts-expect-error The CommonJS declaration has the same readonly contract.
  certificate.castlingExclusions.push({
    right: 'Q',
    blockers: [],
    attackedKingPath: [],
  });
}

const temporal: engine.TemporalPositionCertificate | null =
  engine.analyzeTemporalPosition(
    'kb6/p1p5/P1P5/5pP1/8/8/P1P2P1P/4K3 w - - 0 1',
  );
if (temporal) {
  const regions: readonly engine.TemporalPieceRegion[] = temporal.regions;
  const states: readonly engine.TemporalPieceState[] = regions[0].states;
  const bounds: readonly engine.TemporalPawnBound[] = temporal.pawnBounds;
  const kind: 'finite-pawn-tempo' = temporal.kind;
  void states;
  void bounds;
  void kind;
  // @ts-expect-error CommonJS consumers receive the same immutable certificate.
  temporal.clockSide = 'white';
  // @ts-expect-error Promoted states stay within a readonly original-piece region.
  regions[0].states.push(states[0]);
}

if (temporal) {
  const castles: readonly engine.TemporalCastlingTransition[] =
    temporal.castlingTransitions;
  const exclusions: readonly engine.LockedCastlingExclusion[] =
    temporal.clockCastlingExclusions;
  void exclusions;
  // @ts-expect-error Both module formats expose readonly relocation diagnostics.
  castles[0].kingTo = 'a1';
  // @ts-expect-error The modeled right cannot be rewritten through the API.
  castles[0].right = 'K';
}
