import type {
  Card,
  CreateAnalysisOptions,
  CreateGameOptions,
  EngineError,
  GameEvent,
  HistoryRecord,
  InitialState,
  MatchOutcome,
  PlayerAction,
  Players,
  Result,
  RoundOutcome,
  RoundSeatResult,
  Seat,
  SeatPair,
  TransitionResult,
  ValidationResult,
  XeriKind,
  XeriMark,
  XeriObservation,
  XeriState,
} from './types.js';
import {
  ENGINE_VERSION,
  HAND_SIZE,
  LAYOUT_SIZE,
  RULES_VERSION,
  SCHEMA_VERSION,
  TARGET_SCORE,
} from './types.js';
import { DECK, isCard, randomStream, rankOf, shuffled } from './deck.js';
import { asError, fail, keys, object, text, uint } from './errors.js';

const MAX_RECORDS = 50_000;
const MAX_SNAPSHOT_CHARS = 16_000_000;
const MAX_ANALYSIS_SCORE = 10_000;
const SEED_PATTERN = /^[0-9a-f]{64}$/;
const COUNTING_RANKS: ReadonlySet<string> = new Set(['A', 'K', 'Q', 'J', '10']);
const trusted = new WeakSet<object>();
interface Transition {
  state: XeriState;
  events: GameEvent[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function seal(state: XeriState): XeriState {
  if (JSON.stringify(state).length > MAX_SNAPSHOT_CHARS)
    fail('RESOURCE_LIMIT', 'Snapshot exceeds the supported resource bound.');
  freeze(state);
  trusted.add(state);
  return state;
}
function success(transition: Transition): TransitionResult {
  return {
    ok: true,
    state: seal(transition.state),
    events: freeze(transition.events),
  };
}
function reject(error: unknown): { ok: false; error: EngineError } {
  return { ok: false, error: asError(error) };
}
function other(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}
function replaced<T>(pair: SeatPair<T>, seat: Seat, value: T): SeatPair<T> {
  return seat === 0 ? [value, pair[1]] : [pair[0], value];
}
function parsePlayers(value: unknown): Players {
  if (!Array.isArray(value) || value.length !== 2)
    fail('INVALID_CONFIG', 'Xeri needs exactly two players, by seat.');
  const first = text(value[0], 'Seat 0 player id'),
    second = text(value[1], 'Seat 1 player id');
  if (first === second)
    fail('INVALID_CONFIG', 'Both seats must be different participants.');
  return [first, second];
}
function parseSeed(value: unknown): string {
  if (typeof value !== 'string' || !SEED_PATTERN.test(value))
    fail('INVALID_CONFIG', 'Seed must be 64 lowercase hex characters.');
  return value;
}
function parseSeat(value: unknown): Seat {
  if (value !== 0 && value !== 1)
    fail('INVALID_CONFIG', 'Seat must be 0 or 1.');
  return value;
}
function parseDeck(value: unknown): Card[] {
  if (
    !Array.isArray(value) ||
    value.length !== DECK.length ||
    new Set(value).size !== DECK.length ||
    !value.every(isCard)
  )
    fail(
      'INVALID_CONFIG',
      'A scripted deck must be one complete 52-card deck.',
    );
  return [...value] as Card[];
}
function parseScores(value: unknown): SeatPair<number> {
  if (!Array.isArray(value) || value.length !== 2)
    fail('INVALID_CONFIG', 'Scores must list both seats.');
  return [
    uint(value[0], 'Seat 0 score', MAX_ANALYSIS_SCORE, 'INVALID_CONFIG'),
    uint(value[1], 'Seat 1 score', MAX_ANALYSIS_SCORE, 'INVALID_CONFIG'),
  ];
}
function drawFirstDealer(seed: string): Seat {
  return randomStream(seed, 'first-dealer').below(2) as Seat;
}
function parseInitial(value: unknown): InitialState {
  const o = object(value, 'INVALID_CONFIG');
  keys(
    o,
    ['mode', 'players', 'seed', 'firstDealer', 'decks', 'scores'],
    'INVALID_CONFIG',
  );
  if (o.mode !== 'standard' && o.mode !== 'analysis')
    fail('INVALID_CONFIG', 'Unknown game mode.');
  if (!Array.isArray(o.decks) || o.decks.length > 1_000)
    fail('INVALID_CONFIG', 'Scripted decks must be a bounded array.');
  const seed = parseSeed(o.seed),
    firstDealer = parseSeat(o.firstDealer),
    decks = o.decks.map(parseDeck),
    scores = parseScores(o.scores);
  if (
    o.mode === 'standard' &&
    (decks.length > 0 ||
      scores[0] !== 0 ||
      scores[1] !== 0 ||
      firstDealer !== drawFirstDealer(seed))
  )
    fail(
      'INVALID_CONFIG',
      'A standard game cannot carry scripted decks, opening scores or a chosen dealer.',
    );
  return {
    mode: o.mode,
    players: parsePlayers(o.players),
    seed,
    firstDealer,
    decks,
    scores,
  };
}
function parseAction(value: unknown): PlayerAction {
  const o = object(value);
  if (o.type === 'next') {
    keys(o, ['type']);
    return { type: 'next' };
  }
  keys(o, ['type', 'card']);
  if (o.type !== 'play-card') fail('INVALID_ACTION', 'Unknown action type.');
  if (!isCard(o.card)) fail('INVALID_ACTION', 'Unknown card.');
  return { type: 'play-card', card: o.card };
}
function parseRecord(value: unknown): HistoryRecord {
  const o = object(value, 'INVALID_STATE');
  keys(o, ['kind', 'playerId', 'action'], 'INVALID_STATE');
  if (o.kind !== 'player') fail('INVALID_STATE', 'Unknown record kind.');
  return {
    kind: 'player',
    playerId: text(o.playerId, 'Record player id', 'INVALID_STATE'),
    action: parseAction(o.action),
  };
}
function playerSeat(state: XeriState, playerId: unknown): Seat {
  const seat = state.initial.players.indexOf(playerId as string);
  if (seat < 0) fail('UNKNOWN_PLAYER', 'This player is not in the game.');
  return seat as Seat;
}
function checkRevision(state: XeriState, expectedRevision: unknown): void {
  if (expectedRevision === undefined) return;
  if (
    uint(
      expectedRevision,
      'expectedRevision',
      MAX_RECORDS,
      'STALE_REVISION',
    ) !== state.revision
  )
    fail('STALE_REVISION', 'State revision no longer matches the command.');
}

/** Rulebook 7.1: a covered Jack or pair may stay, but it must not be exposed on top. */
function isBlockedLayout(table: readonly Card[]): boolean {
  const top = table.at(-1)!,
    below = table.at(-2)!;
  return rankOf(top) === 'J' || rankOf(top) === rankOf(below);
}
function dealRound(
  initial: InitialState,
  roundNumber: number,
  dealer: Seat,
): Pick<XeriState, 'hands' | 'table' | 'stock'> {
  const deck =
    initial.decks[roundNumber - 1] ??
    shuffled(DECK, randomStream(initial.seed, `round:${roundNumber}:deck`));
  const dealt = HAND_SIZE * 2;
  const starterHand = deck.slice(0, HAND_SIZE),
    dealerHand = deck.slice(HAND_SIZE, dealt);
  let table = deck.slice(dealt, dealt + LAYOUT_SIZE),
    stock = deck.slice(dealt + LAYOUT_SIZE);
  for (let attempt = 1; isBlockedLayout(table); attempt++) {
    const undealt = shuffled(
      [...table, ...stock],
      randomStream(initial.seed, `round:${roundNumber}:layout:${attempt}`),
    );
    table = undealt.slice(0, LAYOUT_SIZE);
    stock = undealt.slice(LAYOUT_SIZE);
  }
  return {
    hands: dealer === 0 ? [dealerHand, starterHand] : [starterHand, dealerHand],
    table,
    stock,
  };
}
function roundFields(
  initial: InitialState,
  roundNumber: number,
  dealer: Seat,
): Pick<
  XeriState,
  | 'roundNumber'
  | 'dealer'
  | 'batch'
  | 'turn'
  | 'hands'
  | 'table'
  | 'stock'
  | 'captured'
  | 'xeris'
  | 'lastCapturer'
  | 'lastPlay'
> {
  return {
    roundNumber,
    dealer,
    batch: 1,
    turn: other(dealer),
    ...dealRound(initial, roundNumber, dealer),
    captured: [[], []],
    xeris: [],
    lastCapturer: null,
    lastPlay: null,
  };
}
function roundStarted(state: XeriState): GameEvent {
  return {
    type: 'round-started',
    roundNumber: state.roundNumber,
    dealer: state.dealer,
    starter: other(state.dealer),
  };
}
function root(initial: InitialState): Transition {
  const state: XeriState = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSION,
    game: 'xeri',
    initial,
    revision: 0,
    ply: 0,
    ...roundFields(initial, 1, initial.firstDealer),
    scores: initial.scores,
    rounds: [],
    history: [],
    phase: 'playing',
    matchOutcome: null,
  };
  return {
    state,
    events: [{ type: 'game-created', mode: initial.mode }, roundStarted(state)],
  };
}
function seatResult(
  state: XeriState,
  captured: SeatPair<readonly Card[]>,
  seat: Seat,
): RoundSeatResult {
  const own = captured[seat];
  const cardPoints = own.filter((card) =>
      COUNTING_RANKS.has(rankOf(card)),
    ).length,
    tenOfDiamonds = own.includes('10D') ? 1 : 0,
    twoOfClubs = own.includes('2C') ? 1 : 0,
    majority = own.length > captured[other(seat)].length ? 3 : 0,
    xeriPoints = state.xeris
      .filter((mark) => mark.seat === seat)
      .reduce((sum, mark) => sum + mark.points, 0);
  return {
    playerId: state.initial.players[seat],
    seat,
    cards: own.length,
    cardPoints,
    tenOfDiamonds,
    twoOfClubs,
    majority,
    xeriPoints,
    total: cardPoints + tenOfDiamonds + twoOfClubs + majority + xeriPoints,
  };
}
/**
 * The in-game rules text: the higher total at or above the target wins, and an
 * exact tie plays another round. Rulebook 7.5 differs; see the README.
 */
function matchWinner(scores: SeatPair<number>): Seat | null {
  if (scores[0] === scores[1] || Math.max(...scores) < TARGET_SCORE)
    return null;
  return scores[0] > scores[1] ? 0 : 1;
}
function finishRound(state: XeriState, events: GameEvent[]): Transition {
  // The layout's top card is never a Jack, so a Jack always reaches a hand and
  // captures the nonempty pile. Every complete round therefore has a capturer.
  const collector = state.lastCapturer;
  if (collector === null) fail('INVALID_STATE', 'The round has no capturer.');
  const captured = replaced(state.captured, collector, [
    ...state.captured[collector],
    ...state.table,
  ]);
  const results: SeatPair<RoundSeatResult> = [
    seatResult(state, captured, 0),
    seatResult(state, captured, 1),
  ];
  const scores: SeatPair<number> = [
    state.scores[0] + results[0].total,
    state.scores[1] + results[1].total,
  ];
  const outcome: RoundOutcome = {
    roundNumber: state.roundNumber,
    dealer: state.dealer,
    lastCapturer: collector,
    leftoverCards: state.table.length,
    results,
    scores,
  };
  const rounds = [...state.rounds, outcome];
  const roundEvents = [
    ...events,
    { type: 'round-ended', outcome } satisfies GameEvent,
  ];
  const winner = matchWinner(scores);
  if (winner === null) {
    return {
      state: {
        ...state,
        table: [],
        captured,
        scores,
        rounds,
        phase: 'round-end',
      },
      events: roundEvents,
    };
  }
  const score = (seat: Seat) => ({
    playerId: state.initial.players[seat],
    seat,
    points: scores[seat],
  });
  const matchOutcome: MatchOutcome = {
    kind: 'win',
    winner,
    winnerId: state.initial.players[winner],
    reason: 'target-reached',
    roundNumber: state.roundNumber,
    scores: [score(0), score(1)],
  };
  return {
    state: {
      ...state,
      table: [],
      captured,
      scores,
      rounds,
      phase: 'ended',
      matchOutcome,
    },
    events: [...roundEvents, { type: 'match-ended', outcome: matchOutcome }],
  };
}
function dealBatch(state: XeriState, events: GameEvent[]): Transition {
  const starterHand = state.stock.slice(0, HAND_SIZE),
    dealerHand = state.stock.slice(HAND_SIZE, HAND_SIZE * 2),
    starter = other(state.dealer);
  const batch = state.batch + 1;
  return {
    state: {
      ...state,
      batch,
      turn: starter,
      hands:
        state.dealer === 0
          ? [dealerHand, starterHand]
          : [starterHand, dealerHand],
      stock: state.stock.slice(HAND_SIZE * 2),
    },
    events: [
      ...events,
      {
        type: 'batch-dealt',
        roundNumber: state.roundNumber,
        batch,
        starter,
      },
    ],
  };
}
/** Rulebook 7.3: a xeri needs one table card captured by an equal rank. */
function xeriKind(table: readonly Card[], card: Card): XeriKind | null {
  const top = table[0];
  if (table.length !== 1 || !top || rankOf(top) !== rankOf(card)) return null;
  return rankOf(card) === 'J' ? 'jack' : 'ordinary';
}
function reduce(state: XeriState, record: HistoryRecord): Transition {
  if (state.history.length >= MAX_RECORDS)
    fail('RESOURCE_LIMIT', 'History exceeds the supported record limit.');
  if (state.phase === 'ended') fail('GAME_ENDED', 'The match has ended.');
  const seat = playerSeat(state, record.playerId);
  if (record.action.type === 'next') {
    if (state.phase !== 'round-end')
      fail('ILLEGAL_MOVE', 'The round has not ended.');
    const next: XeriState = {
      ...state,
      ...roundFields(state.initial, state.roundNumber + 1, other(state.dealer)),
      phase: 'playing',
      revision: state.revision + 1,
      history: [...state.history, record],
    };
    return { state: next, events: [roundStarted(next)] };
  }
  if (state.phase !== 'playing')
    fail('ILLEGAL_MOVE', 'Continue to the next round before playing a card.');
  if (seat !== state.turn) fail('NOT_YOUR_TURN', 'It is the other turn.');
  const card = record.action.card,
    hand = state.hands[seat];
  if (!hand.includes(card)) fail('ILLEGAL_MOVE', 'That card is not in hand.');
  const top = state.table.at(-1);
  const captures =
    top !== undefined && (rankOf(card) === rankOf(top) || rankOf(card) === 'J');
  const xeri = captures ? xeriKind(state.table, card) : null;
  const capturedCount = captures ? state.table.length + 1 : 0;
  const mark: XeriMark | null = xeri && {
    seat,
    card,
    kind: xeri,
    points: xeri === 'jack' ? 20 : 10,
  };
  const ply = state.ply + 1;
  const hands = replaced(
    state.hands,
    seat,
    hand.filter((held) => held !== card),
  );
  const next: XeriState = {
    ...state,
    revision: state.revision + 1,
    ply,
    turn: other(seat),
    hands,
    table: captures ? [] : [...state.table, card],
    captured: captures
      ? replaced(state.captured, seat, [
          ...state.captured[seat],
          ...state.table,
          card,
        ])
      : state.captured,
    xeris: mark ? [...state.xeris, mark] : state.xeris,
    lastCapturer: captures ? seat : state.lastCapturer,
    lastPlay: { seat, card, capturedCount, xeri },
    history: [...state.history, record],
  };
  const events: GameEvent[] = [
    {
      type: 'card-played',
      playerId: record.playerId,
      seat,
      card,
      capturedCount,
      xeri,
      ply,
    },
  ];
  if (hands[0].length > 0 || hands[1].length > 0)
    return { state: next, events };
  return next.stock.length > 0
    ? dealBatch(next, events)
    : finishRound(next, events);
}

/** JSON structural equality with a strict JSON-only boundary; ignores object key order. */
function canonical(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): string {
  if (depth > 40) fail('INVALID_STATE', 'Snapshot exceeds the nesting limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== 'object' || value === null)
    fail('INVALID_STATE', 'State must contain only JSON values.');
  if (seen.has(value))
    fail('INVALID_STATE', 'Cyclic state is not serializable.');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      fail(
        'INVALID_STATE',
        'Sparse arrays and extra array properties are not permitted.',
      );
    result = `[${value.map((v) => canonical(v, seen, depth + 1)).join(',')}]`;
  } else {
    const o = object(value, 'INVALID_STATE');
    result = `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k], seen, depth + 1)}`)
      .join(',')}}`;
  }
  seen.delete(value);
  return result;
}
function restore(value: unknown): XeriState {
  if (value && typeof value === 'object' && trusted.has(value))
    return value as XeriState;
  const o = object(value, 'INVALID_STATE');
  if (
    o.schemaVersion !== SCHEMA_VERSION ||
    o.engineVersion !== ENGINE_VERSION ||
    o.rulesVersion !== RULES_VERSION
  )
    fail(
      'UNSUPPORTED_VERSION',
      'Snapshot version is unsupported. Migrate explicitly; do not reinterpret an old rules version.',
    );
  if (!Array.isArray(o.history) || o.history.length > MAX_RECORDS)
    fail('INVALID_STATE', 'History is missing or exceeds the record limit.');
  const actual = canonical(value);
  if (actual.length > MAX_SNAPSHOT_CHARS)
    fail('RESOURCE_LIMIT', 'Snapshot exceeds the supported resource bound.');
  let state = root(parseInitial(o.initial)).state;
  for (let index = 0; index < o.history.length; index++) {
    try {
      state = reduce(state, parseRecord(o.history[index])).state;
    } catch (error) {
      fail(
        'INVALID_STATE',
        `Invalid history record ${index}: ${asError(error).message}`,
      );
    }
  }
  if (canonical(state) !== actual)
    fail(
      'INVALID_STATE',
      'Snapshot does not match its replayed deals, history, scores, or outcome.',
    );
  return seal(state);
}

export function createGame(options: CreateGameOptions): TransitionResult {
  try {
    const o = object(options, 'INVALID_CONFIG');
    keys(o, ['players', 'seed'], 'INVALID_CONFIG');
    const seed = parseSeed(o.seed);
    return success(
      root({
        mode: 'standard',
        players: parsePlayers(o.players),
        seed,
        firstDealer: drawFirstDealer(seed),
        decks: [],
        scores: [0, 0],
      }),
    );
  } catch (error) {
    return reject(error);
  }
}
/** Testing/import scenarios only. Never reachable from a funded table. */
export function createAnalysisGame(
  options: CreateAnalysisOptions,
): TransitionResult {
  try {
    const o = object(options, 'INVALID_CONFIG');
    keys(
      o,
      ['players', 'seed', 'firstDealer', 'decks', 'scores'],
      'INVALID_CONFIG',
    );
    return success(
      root(
        parseInitial({ ...o, mode: 'analysis', scores: o.scores ?? [0, 0] }),
      ),
    );
  } catch (error) {
    return reject(error);
  }
}
/** Both humans and bots MUST enter through this same transition function. */
export function applyAction(
  value: XeriState,
  actingPlayer: string,
  input: unknown,
  expectedRevision?: number,
): TransitionResult {
  try {
    const state = restore(value);
    checkRevision(state, expectedRevision);
    playerSeat(state, actingPlayer);
    return success(
      reduce(state, {
        kind: 'player',
        playerId: actingPlayer,
        action: parseAction(input),
      }),
    );
  } catch (error) {
    return reject(error);
  }
}
function actions(state: XeriState, seat: Seat): PlayerAction[] {
  if (state.phase === 'round-end') return [{ type: 'next' }];
  if (state.phase !== 'playing' || state.turn !== seat) return [];
  return state.hands[seat].map((card) => ({ type: 'play-card', card }));
}
export function getLegalActions(
  value: XeriState,
  player: string,
): Result<readonly PlayerAction[]> {
  try {
    const state = restore(value);
    return {
      ok: true,
      value: freeze(actions(state, playerSeat(state, player))),
    };
  } catch (error) {
    return reject(error);
  }
}
export function getObservation(
  value: XeriState,
  viewer: string | null,
): Result<XeriObservation> {
  try {
    const state = restore(value),
      viewerSeat = viewer === null ? null : playerSeat(state, viewer);
    return {
      ok: true,
      value: freeze({
        game: 'xeri',
        rulesVersion: RULES_VERSION,
        revision: state.revision,
        viewer,
        viewerSeat,
        players: state.initial.players,
        ply: state.ply,
        roundNumber: state.roundNumber,
        batch: state.batch,
        dealer: state.dealer,
        turn: state.turn,
        phase: state.phase,
        hand: viewerSeat === null ? [] : state.hands[viewerSeat],
        handCounts: [state.hands[0].length, state.hands[1].length],
        stockCount: state.stock.length,
        table: state.table,
        capturedCounts: [state.captured[0].length, state.captured[1].length],
        xeris: state.xeris,
        lastPlay: state.lastPlay,
        scores: state.scores,
        target: TARGET_SCORE,
        rounds: state.rounds,
        legalActions: viewerSeat === null ? [] : actions(state, viewerSeat),
        matchOutcome: state.matchOutcome,
        analysisRoot: state.initial.mode === 'analysis',
        conformance: { clocks: false },
      }),
    };
  } catch (error) {
    return reject(error);
  }
}
export function validateState(value: unknown): ValidationResult {
  try {
    restore(value);
    return { valid: true, issues: [] };
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          path: '$',
          message: `${asError(error).code}: ${asError(error).message}`,
        },
      ],
    };
  }
}
export function serializeState(value: XeriState): Result<string> {
  try {
    return { ok: true, value: JSON.stringify(restore(value)) };
  } catch (error) {
    return reject(error);
  }
}
export function restoreState(value: unknown): Result<XeriState> {
  try {
    if (typeof value === 'string' && value.length > MAX_SNAPSHOT_CHARS)
      fail('RESOURCE_LIMIT', 'Snapshot is too large.');
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        fail('INVALID_STATE', 'Malformed snapshot JSON.');
      }
    }
    return { ok: true, value: restore(parsed) };
  } catch (error) {
    return reject(error);
  }
}
/** Replay authoritative accepted records. This verifies rules, not their provenance/signatures. */
export function replay(initial: unknown, records: unknown): Result<XeriState> {
  try {
    if (!Array.isArray(records) || records.length > MAX_RECORDS)
      fail('INVALID_STATE', 'Replay records must be a bounded array.');
    let state = root(parseInitial(initial)).state;
    for (const record of records)
      state = reduce(state, parseRecord(record)).state;
    return { ok: true, value: seal(state) };
  } catch (error) {
    return reject(error);
  }
}
export function isGameOver(value: XeriState): Result<boolean> {
  try {
    return { ok: true, value: restore(value).phase === 'ended' };
  } catch (error) {
    return reject(error);
  }
}
