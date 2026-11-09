import type {
  Card,
  CardAction,
  CreateAnalysisOptions,
  CreateGameOptions,
  DilotiObservation,
  DilotiState,
  EngineError,
  GameEvent,
  HistoryRecord,
  InitialState,
  LastPlay,
  LegalActionList,
  MatchOutcome,
  PlayerAction,
  Players,
  Result,
  RoundOutcome,
  RoundSeatResult,
  Seat,
  SeatPair,
  SelectionPreview,
  TableItem,
  TransitionResult,
  ValidationResult,
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
import {
  captureProblem,
  declaration,
  layProblem,
  listActions,
  looseItem,
} from './rules.js';

const MAX_RECORDS = 50_000;
const MAX_SNAPSHOT_CHARS = 16_000_000;
const MAX_ANALYSIS_SCORE = 10_000;
const MAX_SELECTION = DECK.length;
const SEED_PATTERN = /^[0-9a-f]{64}$/;
const COURT_RANKS = ['J', 'Q', 'K'] as const;
const trusted = new WeakSet<object>();
interface Transition {
  state: DilotiState;
  events: GameEvent[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function seal(state: DilotiState): DilotiState {
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
    fail('INVALID_CONFIG', 'Diloti needs exactly two players, by seat.');
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
function parseSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION)
    fail('INVALID_ACTION', 'The table selection must be a bounded list.');
  return value.map((id) => text(id, 'Table item id', 'INVALID_ACTION', 32));
}
function parseAction(value: unknown): PlayerAction {
  const o = object(value);
  if (o.type === 'next') {
    keys(o, ['type']);
    return { type: 'next' };
  }
  if (!isCard(o.card)) fail('INVALID_ACTION', 'Unknown card.');
  if (o.type === 'lay') {
    keys(o, ['type', 'card']);
    return { type: 'lay', card: o.card };
  }
  if (o.type === 'capture') {
    keys(o, ['type', 'card', 'table']);
    return { type: 'capture', card: o.card, table: parseSelection(o.table) };
  }
  if (o.type === 'declare') {
    keys(o, ['type', 'card', 'table', 'value']);
    return {
      type: 'declare',
      card: o.card,
      table: parseSelection(o.table),
      value: uint(o.value, 'Declared value', 100),
    };
  }
  fail('INVALID_ACTION', 'Unknown action type.');
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
function playerSeat(state: DilotiState, playerId: unknown): Seat {
  const seat = state.initial.players.indexOf(playerId as string);
  if (seat < 0) fail('UNKNOWN_PLAYER', 'This player is not in the game.');
  return seat as Seat;
}
function checkRevision(state: DilotiState, expectedRevision: unknown): void {
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

/** Rulebook 6.1: three or four equal court cards in the layout are replaced. */
function isBlockedLayout(table: readonly Card[]): boolean {
  return COURT_RANKS.some(
    (rank) => table.filter((card) => rankOf(card) === rank).length >= 3,
  );
}
function dealRound(
  initial: InitialState,
  roundNumber: number,
  dealer: Seat,
): Pick<DilotiState, 'hands' | 'table' | 'stock'> {
  const deck =
    initial.decks[roundNumber - 1] ??
    shuffled(DECK, randomStream(initial.seed, `round:${roundNumber}:deck`));
  const dealt = HAND_SIZE * 2;
  const starterHand = deck.slice(0, HAND_SIZE),
    dealerHand = deck.slice(HAND_SIZE, dealt);
  let layout = deck.slice(dealt, dealt + LAYOUT_SIZE),
    stock = deck.slice(dealt + LAYOUT_SIZE);
  for (let attempt = 1; isBlockedLayout(layout); attempt++) {
    const undealt = shuffled(
      [...layout, ...stock],
      randomStream(initial.seed, `round:${roundNumber}:layout:${attempt}`),
    );
    layout = undealt.slice(0, LAYOUT_SIZE);
    stock = undealt.slice(LAYOUT_SIZE);
  }
  return {
    hands: dealer === 0 ? [dealerHand, starterHand] : [starterHand, dealerHand],
    table: layout.map(looseItem),
    stock,
  };
}
function roundFields(
  initial: InitialState,
  roundNumber: number,
  dealer: Seat,
): Pick<
  DilotiState,
  | 'roundPly'
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
    roundPly: 0,
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
function roundStarted(state: DilotiState): GameEvent {
  return {
    type: 'round-started',
    roundNumber: state.roundNumber,
    dealer: state.dealer,
    starter: other(state.dealer),
  };
}
function root(initial: InitialState): Transition {
  const state: DilotiState = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSION,
    game: 'diloti',
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
  state: DilotiState,
  captured: SeatPair<readonly Card[]>,
  seat: Seat,
): RoundSeatResult {
  const own = captured[seat];
  const aces = own.filter((card) => rankOf(card) === 'A').length,
    tenOfDiamonds = own.includes('10D') ? 2 : 0,
    twoOfClubs = own.includes('2C') ? 1 : 0,
    majority = own.length > captured[other(seat)].length ? 4 : 0,
    xeriPoints = state.xeris.filter((mark) => mark.seat === seat).length * 10;
  return {
    playerId: state.initial.players[seat],
    seat,
    cards: own.length,
    aces,
    tenOfDiamonds,
    twoOfClubs,
    majority,
    xeriPoints,
    total: aces + tenOfDiamonds + twoOfClubs + majority + xeriPoints,
  };
}
/** Rulebook 6.5: the higher total at or above the target wins; a tie plays on. */
function matchWinner(scores: SeatPair<number>): Seat | null {
  if (scores[0] === scores[1] || Math.max(...scores) < TARGET_SCORE)
    return null;
  return scores[0] > scores[1] ? 0 : 1;
}
function finishRound(state: DilotiState, events: GameEvent[]): Transition {
  // Court cards are never declared and the layout holds at most two of a rank,
  // so some court is forced to capture its match. Every round has a capturer.
  const collector = state.lastCapturer;
  if (collector === null) fail('INVALID_STATE', 'The round has no capturer.');
  const leftovers = state.table.flatMap((item) => item.cards);
  const captured = replaced(state.captured, collector, [
    ...state.captured[collector],
    ...leftovers,
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
    leftoverCards: leftovers.length,
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
function dealBatch(state: DilotiState, events: GameEvent[]): Transition {
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
interface Play {
  table: readonly TableItem[];
  taken: readonly Card[];
  value: number | null;
  group: boolean;
}
function resolvePlay(
  state: DilotiState,
  seat: Seat,
  action: CardAction,
  ply: number,
): Play {
  const { card } = action,
    hand = state.hands[seat],
    table = state.table;
  if (action.type === 'lay') {
    const problem = layProblem(table, seat, card);
    if (problem) fail('ILLEGAL_MOVE', problem);
    return {
      table: [...table, looseItem(card)],
      taken: [],
      value: null,
      group: false,
    };
  }
  const chosen = (item: TableItem) => action.table.includes(item.id);
  if (action.type === 'capture') {
    const problem = captureProblem(table, hand, seat, card, action.table);
    if (problem) fail('ILLEGAL_MOVE', problem);
    return {
      table: table.filter((item) => !chosen(item)),
      taken: [card, ...table.filter(chosen).flatMap((item) => item.cards)],
      value: null,
      group: false,
    };
  }
  const declared = declaration(
    table,
    hand,
    seat,
    card,
    action.table,
    action.value,
  );
  if ('problem' in declared) fail('ILLEGAL_MOVE', declared.problem);
  const unit: TableItem = {
    id: `declaration-${ply}`,
    cards: [card, ...table.filter(chosen).flatMap((item) => item.cards)],
    value: action.value,
    owner: seat,
    group: declared.group,
  };
  return {
    table: [...table.filter((item) => !chosen(item)), unit],
    taken: [],
    value: action.value,
    group: declared.group,
  };
}
function reduce(state: DilotiState, record: HistoryRecord): Transition {
  if (state.history.length >= MAX_RECORDS)
    fail('RESOURCE_LIMIT', 'History exceeds the supported record limit.');
  if (state.phase === 'ended') fail('GAME_ENDED', 'The match has ended.');
  const seat = playerSeat(state, record.playerId);
  if (record.action.type === 'next') {
    if (state.phase !== 'round-end')
      fail('ILLEGAL_MOVE', 'The round has not ended.');
    const next: DilotiState = {
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
  const { action } = record,
    { card } = action,
    hand = state.hands[seat];
  if (!hand.includes(card)) fail('ILLEGAL_MOVE', 'That card is not in hand.');
  const ply = state.ply + 1;
  const play = resolvePlay(state, seat, action, ply);
  const captures = play.taken.length > 0;
  // Rulebook 6.5: any legal capture emptying the table, except the round's first play.
  const xeri = captures && play.table.length === 0 && state.roundPly > 0;
  const hands = replaced(
    state.hands,
    seat,
    hand.filter((held) => held !== card),
  );
  const lastPlay: LastPlay = {
    seat,
    card,
    type: action.type,
    capturedCount: play.taken.length,
    xeri,
    value: play.value,
    group: play.group,
  };
  const next: DilotiState = {
    ...state,
    revision: state.revision + 1,
    ply,
    roundPly: state.roundPly + 1,
    turn: other(seat),
    hands,
    table: play.table,
    captured: captures
      ? replaced(state.captured, seat, [...state.captured[seat], ...play.taken])
      : state.captured,
    xeris: xeri ? [...state.xeris, { seat, card }] : state.xeris,
    lastCapturer: captures ? seat : state.lastCapturer,
    lastPlay,
    history: [...state.history, record],
  };
  const events: GameEvent[] = [
    {
      type: 'card-played',
      playerId: record.playerId,
      seat,
      action,
      capturedCount: play.taken.length,
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
function restore(value: unknown): DilotiState {
  if (value && typeof value === 'object' && trusted.has(value))
    return value as DilotiState;
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
  value: DilotiState,
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
/** Exact, read-only selection checks using the same resolver as accepted plays.
 * No legal-action enumeration, next deal, scoring, history or revision change.
 */
export function previewSelection(
  value: DilotiState,
  player: string,
  input: unknown,
): Result<SelectionPreview> {
  try {
    const state = restore(value),
      seat = playerSeat(state, player);
    if (state.phase === 'ended') fail('GAME_ENDED', 'The match has ended.');
    if (state.phase !== 'playing') fail('ILLEGAL_MOVE', 'The round has ended.');
    if (seat !== state.turn) fail('NOT_YOUR_TURN', 'It is the other turn.');
    const o = object(input);
    keys(o, ['card', 'table']);
    if (!isCard(o.card) || !state.hands[seat].includes(o.card))
      fail('INVALID_ACTION', 'Choose a card from your own hand.');
    const card = o.card,
      table = parseSelection(o.table);
    if (
      new Set(table).size !== table.length ||
      table.some((id) => !state.table.some((item) => item.id === id))
    )
      fail('INVALID_ACTION', 'Choose distinct current table items.');
    const check = (action: CardAction) => {
      try {
        const play = resolvePlay(state, seat, action, state.ply + 1);
        return {
          legal: true,
          capturedCount: play.taken.length,
          xeri:
            play.taken.length > 0 &&
            play.table.length === 0 &&
            state.roundPly > 0,
          group: play.group,
        };
      } catch (error) {
        if (asError(error).code !== 'ILLEGAL_MOVE') throw error;
        return { legal: false, capturedCount: 0, xeri: false, group: false };
      }
    };
    return {
      ok: true,
      value: freeze({
        selection: { card, table },
        lay: check({ type: 'lay', card }),
        capture: check({ type: 'capture', card, table }),
        declarations: Array.from({ length: 10 }, (_, index) =>
          check({ type: 'declare', card, table, value: index + 1 }),
        ),
      }),
    };
  } catch (error) {
    return reject(error);
  }
}
function actions(state: DilotiState, seat: Seat): LegalActionList {
  if (state.phase === 'round-end')
    return { actions: [{ type: 'next' }], complete: true };
  if (state.phase !== 'playing' || state.turn !== seat)
    return { actions: [], complete: true };
  return listActions(state.table, state.hands[seat], seat);
}
export function getLegalActions(
  value: DilotiState,
  player: string,
): Result<LegalActionList> {
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
  value: DilotiState,
  viewer: string | null,
): Result<DilotiObservation> {
  try {
    const state = restore(value),
      viewerSeat = viewer === null ? null : playerSeat(state, viewer);
    const legal =
      viewerSeat === null
        ? { actions: [], complete: true }
        : actions(state, viewerSeat);
    return {
      ok: true,
      value: freeze({
        game: 'diloti',
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
        legalActions: legal.actions,
        legalActionsComplete: legal.complete,
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
export function serializeState(value: DilotiState): Result<string> {
  try {
    return { ok: true, value: JSON.stringify(restore(value)) };
  } catch (error) {
    return reject(error);
  }
}
export function restoreState(value: unknown): Result<DilotiState> {
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
export function replay(
  initial: unknown,
  records: unknown,
): Result<DilotiState> {
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
export function isGameOver(value: DilotiState): Result<boolean> {
  try {
    return { ok: true, value: restore(value).phase === 'ended' };
  } catch (error) {
    return reject(error);
  }
}
