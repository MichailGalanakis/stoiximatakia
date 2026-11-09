import type {
  Card,
  SelectionPreview,
  Combo,
  CreateAnalysisOptions,
  CreateGameOptions,
  EngineError,
  FormatId,
  GameEvent,
  HistoryRecord,
  InitialState,
  LegalActions,
  MatchOutcome,
  PlayAction,
  PlayOption,
  PlayerAction,
  Players,
  Result,
  RoundOutcome,
  TeamResult,
  TichuObservation,
  TichuState,
  TransitionResult,
  ValidationResult,
} from './types.js';
import {
  ENGINE_VERSION,
  FIRST_DEAL,
  FORMATS,
  RULES_VERSION,
  SCHEMA_VERSION,
  SEATS,
  SECOND_DEAL,
} from './types.js';
import { DECK, isCard, randomStream, shuffled } from './deck.js';
import { asError, fail, keys, object, text, uint } from './errors.js';
import {
  beats,
  cardPoints,
  combinations,
  fulfilsWish,
  movesFor,
} from './combos.js';

const MAX_RECORDS = 50_000;
const MAX_SNAPSHOT_CHARS = 16_000_000;
const MAX_ANALYSIS_SCORE = 100_000;
const MAX_OPTION = 64;
const MAX_LISTED = 512;
const EXCHANGE_SIZE = 3;
const SEED_PATTERN = /^[0-9a-f]{64}$/;
const SEAT_LIST = [0, 1, 2, 3];
const trusted = new WeakSet<object>();
interface Transition {
  state: TichuState;
  events: GameEvent[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function seal(state: TichuState): TichuState {
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
function replaced<T>(items: readonly T[], seat: number, value: T): T[] {
  return items.map((item, index) => (index === seat ? value : item));
}
function without(hand: readonly Card[], cards: readonly Card[]): Card[] {
  return hand.filter((card) => !cards.includes(card));
}
function parsePlayers(value: unknown): Players {
  if (!Array.isArray(value) || value.length !== SEATS)
    fail('INVALID_CONFIG', 'Tichu needs exactly four players, by seat.');
  const players = value.map((id, seat) => text(id, `Seat ${seat} player id`));
  if (new Set(players).size !== SEATS)
    fail('INVALID_CONFIG', 'Every seat must be a different participant.');
  return players;
}
function parseSeed(value: unknown): string {
  if (typeof value !== 'string' || !SEED_PATTERN.test(value))
    fail('INVALID_CONFIG', 'Seed must be 64 lowercase hex characters.');
  return value;
}
function parseFormat(value: unknown): FormatId {
  if (value !== 'single' && value !== '500' && value !== '1000')
    fail('INVALID_CONFIG', 'Unknown match format.');
  return value;
}
function parseDeck(value: unknown): Card[] {
  if (
    !Array.isArray(value) ||
    value.length !== DECK.length ||
    new Set(value).size !== DECK.length ||
    !value.every(isCard)
  )
    fail('INVALID_CONFIG', 'A scripted deck must be one complete deck.');
  return value.slice();
}
function parseScores(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 2)
    fail('INVALID_CONFIG', 'Scores must list both teams.');
  return value.map((score, side) => {
    if (
      !Number.isSafeInteger(score) ||
      Math.abs(score as number) > MAX_ANALYSIS_SCORE
    )
      fail('INVALID_CONFIG', `Side ${side} score is out of range.`);
    return score as number;
  });
}
function parseInitial(value: unknown): InitialState {
  const o = object(value, 'INVALID_CONFIG');
  keys(
    o,
    ['mode', 'players', 'seed', 'format', 'decks', 'scores'],
    'INVALID_CONFIG',
  );
  if (o.mode !== 'standard' && o.mode !== 'analysis')
    fail('INVALID_CONFIG', 'Unknown game mode.');
  if (!Array.isArray(o.decks) || o.decks.length > 1_000)
    fail('INVALID_CONFIG', 'Scripted decks must be a bounded array.');
  const seed = parseSeed(o.seed),
    format = parseFormat(o.format),
    decks = o.decks.map(parseDeck),
    scores = parseScores(o.scores);
  if (
    o.mode === 'standard' &&
    (decks.length > 0 || scores.some((score) => score !== 0))
  )
    fail(
      'INVALID_CONFIG',
      'A standard game cannot carry scripted decks or opening scores.',
    );
  return {
    mode: o.mode,
    players: parsePlayers(o.players),
    seed,
    format,
    decks,
    scores,
  };
}
function parseCards(value: unknown): Card[] {
  if (!Array.isArray(value) || value.length > DECK.length)
    fail('INVALID_ACTION', 'Cards must be a bounded array.');
  if (!value.every(isCard)) fail('INVALID_ACTION', 'Unknown card.');
  return value.slice();
}
function parsePlay(o: Record<string, unknown>): PlayAction {
  keys(o, ['type', 'cards', 'option', 'wish']);
  const action = {
    type: 'play' as const,
    cards: parseCards(o.cards),
    option:
      o.option === undefined
        ? 0
        : uint(o.option, 'option', MAX_OPTION, 'INVALID_ACTION'),
  };
  return o.wish === undefined
    ? action
    : { ...action, wish: uint(o.wish, 'wish', 14, 'INVALID_ACTION') };
}
function parseAction(value: unknown): PlayerAction {
  const o = object(value);
  switch (o.type) {
    case 'grand':
      keys(o, ['type', 'call']);
      if (typeof o.call !== 'boolean')
        fail('INVALID_ACTION', 'Say whether you call Grand Tichu.');
      return { type: 'grand', call: o.call };
    case 'exchange':
      keys(o, ['type', 'cards']);
      return { type: 'exchange', cards: parseCards(o.cards) };
    case 'play':
      return parsePlay(o);
    case 'declare':
    case 'pass':
    case 'continue':
    case 'next':
      keys(o, ['type']);
      return { type: o.type };
    case 'dragon':
      keys(o, ['type', 'to']);
      return {
        type: 'dragon',
        to: uint(o.to, 'to', SEATS - 1, 'INVALID_ACTION'),
      };
    default:
      return fail('INVALID_ACTION', 'Unknown action type.');
  }
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
function playerSeat(state: TichuState, playerId: unknown): number {
  const seat = state.initial.players.indexOf(playerId as string);
  if (seat < 0) fail('UNKNOWN_PLAYER', 'This player is not in the game.');
  return seat;
}
function checkRevision(state: TichuState, expectedRevision: unknown): void {
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
function refuse(problem: string | null): void {
  if (problem !== null) fail('ILLEGAL_MOVE', problem);
}
function roundFields(
  initial: InitialState,
  roundNumber: number,
): Pick<
  TichuState,
  | 'roundNumber'
  | 'phase'
  | 'turn'
  | 'hands'
  | 'stock'
  | 'declarations'
  | 'grandDecided'
  | 'exchange'
  | 'hasPlayed'
  | 'top'
  | 'pile'
  | 'captured'
  | 'order'
  | 'wish'
  | 'passes'
  | 'dragonWinner'
  | 'windowPending'
> {
  const deck =
    initial.decks[roundNumber - 1] ??
    shuffled(DECK, randomStream(initial.seed, `round:${roundNumber}:deck`));
  const dealt = FIRST_DEAL * SEATS;
  return {
    roundNumber,
    phase: 'grand',
    turn: null,
    hands: SEAT_LIST.map((seat) =>
      deck.slice(0, dealt).filter((_, index) => index % SEATS === seat),
    ),
    stock: deck.slice(dealt),
    declarations: [0, 0, 0, 0],
    grandDecided: [false, false, false, false],
    exchange: [null, null, null, null],
    hasPlayed: [false, false, false, false],
    top: null,
    pile: [],
    captured: [[], [], [], []],
    order: [],
    wish: null,
    passes: [],
    dragonWinner: null,
    windowPending: [],
  };
}
function root(initial: InitialState): Transition {
  const state: TichuState = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSION,
    game: 'tichu',
    initial,
    revision: 0,
    ply: 0,
    ...roundFields(initial, 1),
    scores: initial.scores,
    rounds: [],
    history: [],
    matchOutcome: null,
  };
  return {
    state,
    events: [
      { type: 'game-created', mode: initial.mode },
      { type: 'round-started', roundNumber: 1 },
    ],
  };
}
function nextActive(state: TichuState, seat: number): number {
  for (let step = 1; step <= SEATS; step++) {
    const next = (seat + step) % SEATS;
    if (state.hands[next]!.length) return next;
  }
  return seat;
}
function isDoubleVictory(order: readonly number[]): boolean {
  return order.length >= 2 && order[0]! % 2 === order[1]! % 2;
}
/** The last player's tricks go to the first out, and their hand to the opponents. */
function cardPointsOf(state: TichuState): number[] {
  const captured = state.captured.map((cards) => [...cards]);
  const last = state.hands.findIndex((hand) => hand.length > 0);
  if (last >= 0) {
    const first = state.order[0]!;
    captured[first]!.push(...captured[last]!);
    captured[last] = [];
    captured[(last + 1) % SEATS]!.push(...state.hands[last]!);
  }
  const points = [0, 0];
  captured.forEach((cards, seat) => {
    points[seat % 2]! += cards.reduce((sum, card) => sum + cardPoints(card), 0);
  });
  return points;
}
function teamResults(state: TichuState): TeamResult[] {
  const double = isDoubleVictory(state.order);
  const cards = double
    ? [0, 1].map((side) => (side === state.order[0]! % 2 ? 200 : 0))
    : cardPointsOf(state);
  return [0, 1].map((side) => {
    const seats = [side, side + 2];
    const declarationPoints = seats.reduce(
      (sum, seat) =>
        sum + state.declarations[seat]! * (state.order[0] === seat ? 1 : -1),
      0,
    );
    return {
      side,
      seats,
      cardPoints: cards[side]!,
      declarationPoints,
      points: cards[side]! + declarationPoints,
    };
  });
}
/** Once the end condition holds a clear leader wins; an exact tie plays another round. */
function matchWinner(state: TichuState, scores: readonly number[]) {
  const { target, rounds } = FORMATS[state.initial.format];
  const reached =
    target > 0 ? Math.max(...scores) >= target : state.roundNumber >= rounds;
  if (!reached || scores[0] === scores[1]) return null;
  return scores[0]! > scores[1]! ? 0 : 1;
}
function finishRound(
  state: TichuState,
  events: readonly GameEvent[],
): Transition {
  const results = teamResults(state);
  const scores = state.scores.map(
    (score, side) => score + results[side]!.points,
  );
  const outcome: RoundOutcome = {
    roundNumber: state.roundNumber,
    order: state.order,
    doubleVictory: isDoubleVictory(state.order),
    declarations: state.declarations,
    results,
    scores,
  };
  const rounds = [...state.rounds, outcome];
  const ended: GameEvent[] = [...events, { type: 'round-ended', outcome }];
  const winner = matchWinner(state, scores);
  if (winner === null)
    return {
      state: { ...state, scores, rounds, phase: 'round-end', turn: null },
      events: ended,
    };
  const winners = [winner, winner + 2];
  const matchOutcome: MatchOutcome = {
    kind: 'win',
    side: winner,
    winners,
    winnerIds: winners.map((seat) => state.initial.players[seat]!),
    reason:
      FORMATS[state.initial.format].target > 0
        ? 'target-reached'
        : 'single-round',
    roundNumber: state.roundNumber,
    scores,
  };
  return {
    state: {
      ...state,
      scores,
      rounds,
      phase: 'ended',
      turn: null,
      matchOutcome,
    },
    events: [...ended, { type: 'match-ended', outcome: matchOutcome }],
  };
}
function collect(
  state: TichuState,
  recipient: number,
  events: readonly GameEvent[],
): Transition {
  const winner = state.top!.player;
  const next: TichuState = {
    ...state,
    captured: replaced(state.captured, recipient, [
      ...state.captured[recipient]!,
      ...state.pile,
    ]),
    pile: [],
    top: null,
    passes: [],
    dragonWinner: null,
    windowPending: [],
    phase: 'play',
  };
  const taken: GameEvent[] = [
    ...events,
    { type: 'trick-taken', seat: recipient, cardCount: state.pile.length },
  ];
  if (state.order.length === 3) return finishRound(next, taken);
  return {
    state: {
      ...next,
      turn: state.hands[winner]!.length ? winner : nextActive(state, winner),
    },
    events: taken,
  };
}
function resolveTrick(
  state: TichuState,
  events: readonly GameEvent[],
): Transition {
  const top = state.top!;
  if (top.combo.kind === 'single' && top.cards[0] === 'DRAGON')
    return {
      state: {
        ...state,
        phase: 'dragon',
        turn: top.player,
        dragonWinner: top.player,
        windowPending: [],
      },
      events: [...events],
    };
  return collect(state, top.player, events);
}
/** Every remaining seat answers; eligibility never depends on a hidden bomb. */
function openBombWindow(
  state: TichuState,
  events: readonly GameEvent[],
): Transition {
  const windowPending = SEAT_LIST.filter(
    (seat) => state.hands[seat]!.length > 0,
  );
  return windowPending.length
    ? {
        state: { ...state, phase: 'bomb-window', turn: null, windowPending },
        events: [...events],
      }
    : resolveTrick(state, events);
}
function grand(state: TichuState, seat: number, call: boolean): Transition {
  if (state.phase !== 'grand')
    fail('ILLEGAL_MOVE', 'Grand Tichu is decided on the first eight cards.');
  if (state.grandDecided[seat])
    fail('ILLEGAL_MOVE', 'You have already decided.');
  const grandDecided = replaced(state.grandDecided, seat, true);
  const declarations = replaced(state.declarations, seat, call ? 200 : 0);
  const events: GameEvent[] = [
    {
      type: 'grand-decided',
      playerId: state.initial.players[seat]!,
      seat,
      call,
    },
  ];
  if (grandDecided.includes(false))
    return { state: { ...state, grandDecided, declarations }, events };
  const rest = (seatIndex: number) =>
    state.stock
      .slice(0, SECOND_DEAL * SEATS)
      .filter((_, index) => index % SEATS === seatIndex);
  return {
    state: {
      ...state,
      grandDecided,
      declarations,
      phase: 'exchange',
      hands: state.hands.map((hand, index) => [...hand, ...rest(index)]),
      stock: state.stock.slice(SECOND_DEAL * SEATS),
    },
    events: [
      ...events,
      { type: 'cards-dealt', roundNumber: state.roundNumber },
    ],
  };
}
function exchange(
  state: TichuState,
  seat: number,
  cards: readonly Card[],
): Transition {
  if (state.phase !== 'exchange') fail('ILLEGAL_MOVE', 'Not the exchange.');
  if (state.exchange[seat]) fail('ILLEGAL_MOVE', 'You have already chosen.');
  if (cards.length !== EXCHANGE_SIZE || new Set(cards).size !== EXCHANGE_SIZE)
    fail('ILLEGAL_MOVE', 'Choose three different cards.');
  if (!cards.every((card) => state.hands[seat]!.includes(card)))
    fail('ILLEGAL_MOVE', 'A chosen card is not in hand.');
  const committed = replaced(state.exchange, seat, cards);
  const events: GameEvent[] = [
    {
      type: 'exchange-committed',
      playerId: state.initial.players[seat]!,
      seat,
    },
  ];
  if (committed.includes(null))
    return { state: { ...state, exchange: committed }, events };
  const hands = state.hands.map((hand, target) => [
    ...without(hand, committed[target]!),
    ...SEAT_LIST.flatMap((giver) =>
      committed[giver]!.filter(
        (_, index) => (giver + index + 1) % SEATS === target,
      ),
    ),
  ]);
  const lead = hands.findIndex((hand) => hand.includes('MAHJONG'));
  return {
    state: {
      ...state,
      hands,
      exchange: [null, null, null, null],
      phase: 'play',
      turn: lead,
    },
    events: [...events, { type: 'exchange-done', lead }],
  };
}
const DECLARE_PHASES: readonly string[] = [
  'exchange',
  'play',
  'bomb-window',
  'dragon',
];
function canDeclare(state: TichuState, seat: number): boolean {
  return (
    DECLARE_PHASES.includes(state.phase) &&
    !state.hasPlayed[seat] &&
    !state.declarations[seat]
  );
}
function declare(state: TichuState, seat: number): Transition {
  if (!canDeclare(state, seat))
    fail(
      'ILLEGAL_MOVE',
      'Tichu is called once, holding all fourteen cards, before your first play.',
    );
  return {
    state: {
      ...state,
      declarations: replaced(state.declarations, seat, 100),
    },
    events: [
      {
        type: 'tichu-declared',
        playerId: state.initial.players[seat]!,
        seat,
      },
    ],
  };
}
function dragon(state: TichuState, seat: number, to: number): Transition {
  if (state.phase !== 'dragon')
    fail('ILLEGAL_MOVE', 'No Dragon trick to give.');
  if (seat !== state.dragonWinner)
    fail('NOT_YOUR_TURN', 'The Dragon player gives this trick.');
  if (to % 2 === seat % 2)
    fail('ILLEGAL_MOVE', 'Give the trick to one of the opponents.');
  return collect(state, to, []);
}
function hasWishMove(state: TichuState, seat: number): boolean {
  const wish = state.wish;
  return (
    wish !== null &&
    movesFor(state.hands[seat]!, state.top?.combo ?? null).some((move) =>
      fulfilsWish(move.cards, wish),
    )
  );
}
function continueWindow(state: TichuState, seat: number): Transition {
  if (state.phase !== 'bomb-window')
    fail('ILLEGAL_MOVE', 'There is no bomb window open.');
  if (!state.windowPending.includes(seat))
    fail('ILLEGAL_MOVE', 'Nothing is waiting on you.');
  const windowPending = state.windowPending.filter((item) => item !== seat);
  return windowPending.length
    ? { state: { ...state, windowPending }, events: [] }
    : resolveTrick({ ...state, windowPending }, []);
}
function pass(state: TichuState, seat: number): Transition {
  if (state.phase !== 'play' || seat !== state.turn)
    fail('NOT_YOUR_TURN', 'It is another turn.');
  const top = state.top;
  if (!top) fail('ILLEGAL_MOVE', 'You cannot pass when you lead.');
  if (hasWishMove(state, seat))
    fail('ILLEGAL_MOVE', 'You can fulfil the wish, so you must play.');
  const passes = [...state.passes, seat];
  const next: TichuState = { ...state, passes };
  const events: GameEvent[] = [
    {
      type: 'passed',
      playerId: state.initial.players[seat]!,
      seat,
    },
  ];
  const waiting = SEAT_LIST.filter(
    (item) => state.hands[item]!.length > 0 && item !== top.player,
  );
  return waiting.every((item) => passes.includes(item))
    ? openBombWindow(next, events)
    : { state: { ...next, turn: nextActive(state, seat) }, events };
}
function chosenCombo(state: TichuState, action: PlayAction): Combo {
  const top = state.top?.combo ?? null;
  const combo = combinations(action.cards, top)[action.option];
  if (!combo || !beats(combo, top))
    fail(
      'ILLEGAL_MOVE',
      'The play must beat the table with the same type and size, or be a bomb.',
    );
  return combo;
}
function wishAfter(state: TichuState, action: PlayAction): number | null {
  const mahjong = action.cards.includes('MAHJONG');
  if (!mahjong) {
    if (action.wish !== undefined)
      fail('INVALID_ACTION', 'Only the Mah Jong makes a wish.');
    return state.wish !== null && fulfilsWish(action.cards, state.wish)
      ? null
      : state.wish;
  }
  const wish = action.wish;
  if (wish === undefined || wish === 1)
    fail('ILLEGAL_MOVE', 'Choose a wish from 2 to Ace, or none.');
  return wish || null;
}
function playProblem(
  state: TichuState,
  seat: number,
  action: PlayAction,
): void {
  if (state.phase !== 'play' && state.phase !== 'bomb-window')
    fail('ILLEGAL_MOVE', 'Cards cannot be played now.');
  if (new Set(action.cards).size !== action.cards.length)
    fail('ILLEGAL_MOVE', 'Choose different cards.');
  if (!action.cards.every((card) => state.hands[seat]!.includes(card)))
    fail('ILLEGAL_MOVE', 'A chosen card is not in hand.');
}
/** The one way a play ends a round early, leaving the rest of the trick unresolved. */
function afterDog(state: TichuState, seat: number, events: GameEvent[]) {
  const finished = isDoubleVictory(state.order) || state.order.length === 3;
  if (finished) return finishRound(state, events);
  const partner = (seat + 2) % SEATS;
  return {
    state: {
      ...state,
      turn: state.hands[partner]!.length ? partner : nextActive(state, partner),
    },
    events,
  };
}
function play(state: TichuState, seat: number, action: PlayAction): Transition {
  playProblem(state, seat, action);
  const combo = chosenCombo(state, action);
  const outOfTurn = state.phase === 'bomb-window' || seat !== state.turn;
  if (outOfTurn) {
    if (!combo.bomb)
      fail('NOT_YOUR_TURN', 'Out of turn, only a bomb is played.');
    // The designer's game offers an interrupt only against a play on the table.
    if (!state.top)
      fail('ILLEGAL_MOVE', 'A bomb cannot take over an empty table.');
  } else if (state.wish !== null && hasWishMove(state, seat)) {
    refuse(
      fulfilsWish(action.cards, state.wish)
        ? null
        : 'You must play the wished rank when you can.',
    );
  }
  const wish = wishAfter(state, action);
  const hand = without(state.hands[seat]!, action.cards);
  const out = hand.length === 0 && !state.order.includes(seat);
  const next: TichuState = {
    ...state,
    wish,
    hands: replaced(state.hands, seat, hand),
    hasPlayed: replaced(state.hasPlayed, seat, true),
    order: out ? [...state.order, seat] : state.order,
    phase: 'play',
    passes: [],
    windowPending: [],
  };
  const events: GameEvent[] = [
    {
      type: 'cards-played',
      playerId: state.initial.players[seat]!,
      seat,
      cards: action.cards,
      combo,
      wish,
      outOfTurn,
    },
  ];
  if (out)
    events.push({
      type: 'player-out',
      seat,
      place: state.order.length + 1,
    });
  if (combo.kind === 'dog')
    return afterDog(
      {
        ...next,
        captured: replaced(state.captured, seat, [
          ...state.captured[seat]!,
          ...action.cards,
        ]),
      },
      seat,
      events,
    );
  const played: TichuState = {
    ...next,
    pile: [...state.pile, ...action.cards],
    top: { player: seat, combo, cards: action.cards },
  };
  if (out && isDoubleVictory(played.order)) return finishRound(played, events);
  if (out && played.order.length === 3) return resolveTrick(played, events);
  return { state: { ...played, turn: nextActive(played, seat) }, events };
}
function act(
  state: TichuState,
  seat: number,
  action: Exclude<PlayerAction, { type: 'next' }>,
): Transition {
  switch (action.type) {
    case 'grand':
      return grand(state, seat, action.call);
    case 'exchange':
      return exchange(state, seat, action.cards);
    case 'declare':
      return declare(state, seat);
    case 'dragon':
      return dragon(state, seat, action.to);
    case 'continue':
      return continueWindow(state, seat);
    case 'pass':
      return pass(state, seat);
    case 'play':
      return play(state, seat, action);
  }
}
function reduce(state: TichuState, record: HistoryRecord): Transition {
  if (state.history.length >= MAX_RECORDS)
    fail('RESOURCE_LIMIT', 'History exceeds the supported record limit.');
  if (state.phase === 'ended') fail('GAME_ENDED', 'The match has ended.');
  const counted = {
    ...state,
    revision: state.revision + 1,
    history: [...state.history, record],
  };
  const seat = playerSeat(state, record.playerId);
  if (record.action.type === 'next') {
    if (state.phase !== 'round-end')
      fail('ILLEGAL_MOVE', 'The round has not ended.');
    const roundNumber = state.roundNumber + 1;
    return {
      state: { ...counted, ...roundFields(state.initial, roundNumber) },
      events: [{ type: 'round-started', roundNumber }],
    };
  }
  if (state.phase === 'round-end')
    fail('ILLEGAL_MOVE', 'Continue to the next round before playing.');
  return act({ ...counted, ply: state.ply + 1 }, seat, record.action);
}
function wishes(move: { cards: readonly Card[] }): (number | undefined)[] {
  if (!move.cards.includes('MAHJONG')) return [undefined];
  return [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
}
function playActions(state: TichuState, seat: number): PlayerAction[] {
  const hand = state.hands[seat]!,
    top = state.top?.combo ?? null;
  const inTurn = state.phase === 'play' && seat === state.turn;
  const moves = movesFor(hand, top).filter(
    (move) => inTurn || (state.top && move.combo.bomb > 0),
  );
  const wish = state.wish;
  const forced =
    inTurn && wish !== null
      ? moves.filter((move) => fulfilsWish(move.cards, wish))
      : [];
  return (forced.length ? forced : moves).flatMap((move) =>
    wishes(move).map((value) => ({
      type: 'play' as const,
      cards: move.cards,
      option: move.option,
      ...(value === undefined ? {} : { wish: value }),
    })),
  );
}
function exchangeActions(hand: readonly Card[]): PlayerAction[] {
  const actions: PlayerAction[] = [];
  for (const first of hand)
    for (const second of hand)
      for (const third of hand) {
        if (first === second || first === third || second === third) continue;
        actions.push({ type: 'exchange', cards: [first, second, third] });
        if (actions.length > MAX_LISTED) return actions;
      }
  return actions;
}
function requiredActions(state: TichuState, seat: number): PlayerAction[] {
  switch (state.phase) {
    case 'grand':
      return state.grandDecided[seat]
        ? []
        : [
            { type: 'grand', call: false },
            { type: 'grand', call: true },
          ];
    case 'exchange':
      return state.exchange[seat] ? [] : exchangeActions(state.hands[seat]!);
    case 'dragon':
      return seat === state.dragonWinner
        ? [
            { type: 'dragon', to: (seat + 1) % SEATS },
            { type: 'dragon', to: (seat + 3) % SEATS },
          ]
        : [];
    case 'bomb-window':
      return state.windowPending.includes(seat)
        ? [...playActions(state, seat), { type: 'continue' }]
        : playActions(state, seat);
    case 'round-end':
      return [{ type: 'next' }];
    case 'play':
      if (seat !== state.turn) return playActions(state, seat);
      if (!state.top || hasWishMove(state, seat))
        return playActions(state, seat);
      return [...playActions(state, seat), { type: 'pass' }];
    default:
      return [];
  }
}
/** Choices of cards are capped; passing, declining and calling Tichu are always listed. */
function listActions(state: TichuState, seat: number): LegalActions {
  const required = requiredActions(state, seat);
  const chooses = (action: PlayerAction) =>
    action.type === 'play' || action.type === 'exchange';
  const choices = required.filter(chooses);
  const declared: PlayerAction[] = canDeclare(state, seat)
    ? [{ type: 'declare' }]
    : [];
  return {
    actions: [
      ...choices.slice(0, MAX_LISTED),
      ...required.filter((action) => !chooses(action)),
      ...declared,
    ],
    complete: choices.length <= MAX_LISTED,
  };
}
function isYourMove(state: TichuState, seat: number): boolean {
  switch (state.phase) {
    case 'round-end':
      return true;
    case 'grand':
      return !state.grandDecided[seat];
    case 'exchange':
      return !state.exchange[seat];
    case 'bomb-window':
      return state.windowPending.includes(seat);
    case 'play':
    case 'dragon':
      return state.turn === seat;
    default:
      return false;
  }
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
function restore(value: unknown): TichuState {
  if (value && typeof value === 'object' && trusted.has(value))
    return value as TichuState;
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
    keys(o, ['players', 'seed', 'format'], 'INVALID_CONFIG');
    return success(
      root({
        mode: 'standard',
        players: parsePlayers(o.players),
        seed: parseSeed(o.seed),
        format: parseFormat(o.format),
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
    keys(o, ['players', 'seed', 'format', 'decks', 'scores'], 'INVALID_CONFIG');
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
  value: TichuState,
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
export function getLegalActions(
  value: TichuState,
  player: string,
): Result<LegalActions> {
  try {
    const state = restore(value);
    return {
      ok: true,
      value: freeze(listActions(state, playerSeat(state, player))),
    };
  } catch (error) {
    return reject(error);
  }
}
/** The readings a player can choose between for cards they hold, in `option` order. */
export function getPlayOptions(
  value: TichuState,
  player: string,
  input: unknown,
): Result<readonly PlayOption[]> {
  try {
    const state = restore(value),
      seat = playerSeat(state, player),
      cards = parseCards(input);
    if (new Set(cards).size !== cards.length)
      fail('ILLEGAL_MOVE', 'Choose different cards.');
    if (!cards.every((card) => state.hands[seat]!.includes(card)))
      fail('ILLEGAL_MOVE', 'A chosen card is not in hand.');
    const top = state.top?.combo ?? null;
    return {
      ok: true,
      value: freeze(
        combinations(cards, top).flatMap((combo, option) =>
          beats(combo, top) ? [{ ...combo, option }] : [],
        ),
      ),
    };
  } catch (error) {
    return reject(error);
  }
}
export function getObservation(
  value: TichuState,
  viewer: string | null,
): Result<TichuObservation> {
  try {
    const state = restore(value),
      viewerSeat = viewer === null ? null : playerSeat(state, viewer);
    const legal =
      viewerSeat === null
        ? { actions: [], complete: true }
        : listActions(state, viewerSeat);
    return {
      ok: true,
      value: freeze({
        game: 'tichu',
        rulesVersion: RULES_VERSION,
        format: state.initial.format,
        revision: state.revision,
        viewer,
        viewerSeat,
        players: state.initial.players,
        ply: state.ply,
        roundNumber: state.roundNumber,
        phase: state.phase,
        turn: state.turn,
        yourMove: viewerSeat !== null && isYourMove(state, viewerSeat),
        hand: viewerSeat === null ? [] : state.hands[viewerSeat]!,
        handCounts: state.hands.map((hand) => hand.length),
        declarations: state.declarations,
        grandDecided: state.grandDecided,
        exchangeCommitted: state.exchange.map((cards) => cards !== null),
        hasPlayed: state.hasPlayed,
        top: state.top,
        pileCount: state.pile.length,
        capturedCounts: state.captured.map((cards) => cards.length),
        order: state.order,
        wish: state.wish,
        dragonWinner: state.dragonWinner,
        scores: state.scores,
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
export function serializeState(value: TichuState): Result<string> {
  try {
    return { ok: true, value: JSON.stringify(restore(value)) };
  } catch (error) {
    return reject(error);
  }
}
export function restoreState(value: unknown): Result<TichuState> {
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
export function replay(initial: unknown, records: unknown): Result<TichuState> {
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
export function isGameOver(value: TichuState): Result<boolean> {
  try {
    return { ok: true, value: restore(value).phase === 'ended' };
  } catch (error) {
    return reject(error);
  }
}

/** Exact own selection, independent of capped suggestions; no state/history mutation. */
export function previewSelection(
  value: TichuState,
  player: string,
  input: unknown,
): Result<SelectionPreview> {
  try {
    const state = restore(value),
      selection = object(input, 'INVALID_ACTION');
    keys(selection, ['cards', 'wish']);
    if (state.phase !== 'play' && state.phase !== 'bomb-window')
      fail('ILLEGAL_MOVE', 'No cards can be played in this phase.');
    const cards = parseCards(selection.cards);
    const hasWish = Object.hasOwn(selection, 'wish');
    if (hasWish) uint(selection.wish, 'wish', 14);
    if (
      cards.includes('MAHJONG') !== hasWish ||
      (hasWish && selection.wish === 1)
    )
      fail('INVALID_ACTION', 'Choose a wish with the Mah Jong only.');
    const options = getPlayOptions(state, player, cards);
    if (!options.ok) return options;
    const chosen = {
      cards,
      ...(hasWish ? { wish: selection.wish as number } : {}),
    };
    return {
      ok: true,
      value: freeze({
        selection: chosen,
        options: options.value.map((option) => ({
          ...option,
          legal: applyAction(state, player, {
            type: 'play',
            ...chosen,
            option: option.option,
          }).ok,
        })),
      }),
    };
  } catch (error) {
    return reject(error);
  }
}
