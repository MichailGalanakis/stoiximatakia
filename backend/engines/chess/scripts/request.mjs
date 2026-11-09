import {
  createGame,
  createAnalysisGame,
  applyAction,
  getObservation,
  getLegalActions,
  getDrawClaims,
  validateState,
  restoreState,
  serializeState,
  replay,
  chooseBotAction,
} from '../dist/esm/index.js';

/** Development/local adapter only. Deliberately exposes no adjudicator endpoint. */
export function dispatch(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    return bad('Expected an object request.');
  switch (request.op) {
    case 'create':
      return createGame({ players: request.players });
    case 'create-analysis':
      return createAnalysisGame({
        players: request.players,
        fen: request.fen,
        ...(request.movesBeforeStart === undefined
          ? {}
          : { movesBeforeStart: request.movesBeforeStart }),
      });
    case 'apply':
      return applyAction(
        request.state,
        request.playerId,
        request.action,
        request.expectedRevision,
      );
    case 'observe':
      return getObservation(
        request.state,
        request.viewer === undefined ? null : request.viewer,
      );
    case 'legal':
      return getLegalActions(request.state, request.playerId);
    case 'claims':
      return getDrawClaims(request.state, request.playerId);
    case 'validate':
      return { ok: true, value: validateState(request.state) };
    case 'restore':
      return restoreState(request.snapshot);
    case 'serialize':
      return serializeState(request.state);
    case 'replay':
      return replay(request.initial, request.records);
    case 'bot':
      return chooseBotAction(request.observation, request.options);
    default:
      return bad(
        'Unknown operation. Adjudication is available only through the trusted library API.',
      );
  }
}
function bad(message) {
  return { ok: false, error: { code: 'INVALID_REQUEST', message } };
}
