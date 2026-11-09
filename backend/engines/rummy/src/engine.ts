import type {
  Card,
  CreateAnalysisOptions,
  CreateGameOptions,
  EngineError,
  GameEvent,
  GameId,
  HistoryRecord,
  InitialState,
  LegalActions,
  MatchOutcome,
  Meld,
  MeldOption,
  MeldOptionsRequest,
  MeldSlot,
  PlayerAction,
  Players,
  Result,
  RoundOutcome,
  RummyObservation,
  RummyState,
  SelectionPreview,
  SideResult,
  TransitionResult,
  ValidationResult,
} from './types.js';
import {
  BIRIBA_TARGET,
  ENGINE_VERSION,
  HAND_SIZE,
  KOUMKAN_LIMIT,
  RESERVE_SIZE,
  RULES_VERSIONS,
  SCHEMA_VERSION,
  SEATS,
  THANASIS_DEALS,
} from './types.js';
import {
  DECKS,
  isCard,
  randomStream,
  rankOf,
  shuffled,
  suitOf,
} from './deck.js';
import { asError, fail, keys, object, text, uint } from './errors.js';
import {
  biribaBonus,
  closingMelds,
  extendOptions,
  leastPenalty,
  meldOptions,
  pointsOf,
  shortMelds,
  sideOf,
} from './rules.js';
import {
  closeProblem,
  discardProblem,
  drawProblem,
  extendProblem,
  listActions,
  meldFrom,
  meldProblem,
  replaceProblem,
  replacedHand,
  replacedSlot,
  withSlots,
  without,
} from './legal.js';

const MAX_RECORDS = 50_000;
const MAX_SNAPSHOT_CHARS = 16_000_000;
const MAX_ANALYSIS_SCORE = 10_000;
const MAX_OPTION = 4_096;
const MAX_MELD_ID = 16;
const SEED_PATTERN = /^[0-9a-f]{64}$/;
const trusted = new WeakSet<object>();
interface Transition {
  state: RummyState;
  events: GameEvent[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function seal(state: RummyState): RummyState {
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
function refuse(problem: string | null): void {
  if (problem !== null) fail('ILLEGAL_MOVE', problem);
}
function parseGame(value: unknown): GameId {
  if (value !== 'koumkan' && value !== 'thanasis' && value !== 'biriba')
    fail('INVALID_CONFIG', 'Unknown game.');
  return value;
}
function parsePlayers(value: unknown, game: GameId): Players {
  const seats = SEATS[game];
  if (!Array.isArray(value) || value.length !== seats)
    fail(
      'INVALID_CONFIG',
      `This game needs exactly ${seats} players, by seat.`,
    );
  const players = value.map((id, seat) => text(id, `Seat ${seat} player id`));
  if (new Set(players).size !== players.length)
    fail('INVALID_CONFIG', 'Every seat must be a different participant.');
  return players;
}
function parseSeed(value: unknown): string {
  if (typeof value !== 'string' || !SEED_PATTERN.test(value))
    fail('INVALID_CONFIG', 'Seed must be 64 lowercase hex characters.');
  return value;
}
function parseSeat(value: unknown, game: GameId): number {
  return uint(value, 'Seat', SEATS[game] - 1, 'INVALID_CONFIG');
}
function parseDeck(value: unknown, game: GameId): Card[] {
  const known = new Set<unknown>(DECKS[game]);
  if (
    !Array.isArray(value) ||
    value.length !== known.size ||
    new Set(value).size !== known.size ||
    !value.every((card) => known.has(card))
  )
    fail('INVALID_CONFIG', 'A scripted deck must be one complete deck.');
  return (value as Card[]).slice();
}
function sideCount(game: GameId): number {
  return game === 'biriba' ? 2 : SEATS[game];
}
function parseScores(value: unknown, game: GameId): number[] {
  if (!Array.isArray(value) || value.length !== sideCount(game))
    fail('INVALID_CONFIG', 'Scores must list every side.');
  return value.map((score, side) => {
    if (
      !Number.isSafeInteger(score) ||
      Math.abs(score as number) > MAX_ANALYSIS_SCORE
    )
      fail('INVALID_CONFIG', `Side ${side} score is out of range.`);
    return score as number;
  });
}
function drawFirstStarter(seed: string, game: GameId): number {
  return randomStream(seed, 'first-starter').below(SEATS[game]);
}
function parseInitial(value: unknown): InitialState {
  const o = object(value, 'INVALID_CONFIG');
  keys(
    o,
    ['mode', 'game', 'players', 'seed', 'firstStarter', 'decks', 'scores'],
    'INVALID_CONFIG',
  );
  if (o.mode !== 'standard' && o.mode !== 'analysis')
    fail('INVALID_CONFIG', 'Unknown game mode.');
  if (!Array.isArray(o.decks) || o.decks.length > 1_000)
    fail('INVALID_CONFIG', 'Scripted decks must be a bounded array.');
  const game = parseGame(o.game),
    seed = parseSeed(o.seed),
    firstStarter = parseSeat(o.firstStarter, game),
    decks = o.decks.map((deck) => parseDeck(deck, game)),
    scores = parseScores(o.scores, game);
  if (
    o.mode === 'standard' &&
    (decks.length > 0 ||
      scores.some((score) => score !== 0) ||
      firstStarter !== drawFirstStarter(seed, game))
  )
    fail(
      'INVALID_CONFIG',
      'A standard game cannot carry scripted decks, opening scores or a chosen starter.',
    );
  return {
    mode: o.mode,
    game,
    players: parsePlayers(o.players, game),
    seed,
    firstStarter,
    decks,
    scores,
  };
}
function parseCard(value: unknown): Card {
  if (!isCard(value)) fail('INVALID_ACTION', 'Unknown card.');
  return value;
}
function parseCards(value: unknown): Card[] {
  if (!Array.isArray(value) || value.length > DECKS.biriba.length)
    fail('INVALID_ACTION', 'Cards must be a bounded array.');
  return value.map(parseCard);
}
function parseMeldId(value: unknown): string {
  return text(value, 'Meld id', 'INVALID_ACTION', MAX_MELD_ID);
}
function parseOption(value: unknown): number {
  return value === undefined
    ? 0
    : uint(value, 'option', MAX_OPTION, 'INVALID_ACTION');
}
function parseAction(value: unknown): PlayerAction {
  const o = object(value);
  switch (o.type) {
    case 'draw':
      keys(o, ['type', 'source']);
      if (o.source !== 'stock' && o.source !== 'discard')
        fail('INVALID_ACTION', 'Draw from the stock or the discard pile.');
      return { type: 'draw', source: o.source };
    case 'meld':
      keys(o, ['type', 'cards', 'option']);
      return {
        type: 'meld',
        cards: parseCards(o.cards),
        option: parseOption(o.option),
      };
    case 'extend':
      keys(o, ['type', 'meld', 'cards', 'option']);
      return {
        type: 'extend',
        meld: parseMeldId(o.meld),
        cards: parseCards(o.cards),
        option: parseOption(o.option),
      };
    case 'replace':
      keys(o, ['type', 'meld', 'card']);
      return {
        type: 'replace',
        meld: parseMeldId(o.meld),
        card: parseCard(o.card),
      };
    case 'discard':
    case 'close':
      keys(o, ['type', 'card']);
      return { type: o.type, card: parseCard(o.card) };
    case 'next':
      keys(o, ['type']);
      return { type: 'next' };
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
function playerSeat(state: RummyState, playerId: unknown): number {
  const seat = state.initial.players.indexOf(playerId as string);
  if (seat < 0) fail('UNKNOWN_PLAYER', 'This player is not in the game.');
  return seat;
}
function checkRevision(state: RummyState, expectedRevision: unknown): void {
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
/** Packets come off the top, then the hands, then the indicator; a Joker goes under the stock. */
function roundFields(
  initial: InitialState,
  roundNumber: number,
): Pick<
  RummyState,
  | 'roundNumber'
  | 'starter'
  | 'turn'
  | 'phase'
  | 'hands'
  | 'stock'
  | 'discard'
  | 'indicator'
  | 'wildRank'
  | 'trump'
  | 'melds'
  | 'opened'
  | 'reserves'
  | 'reserveTaken'
  | 'reserveWaiting'
  | 'pickup'
  | 'mustUsePickup'
  | 'turnDrawn'
> {
  const { game, seed } = initial,
    seats = SEATS[game];
  const deck =
    initial.decks[roundNumber - 1] ??
    shuffled(DECKS[game], randomStream(seed, `round:${roundNumber}:deck`));
  const packets = game === 'biriba' ? 2 : 0,
    dealFrom = packets * RESERVE_SIZE,
    dealTo = dealFrom + HAND_SIZE[game] * seats;
  const dealt = deck.slice(dealFrom, dealTo),
    undealt = deck.slice(dealTo),
    turned = undealt.findIndex((card) => rankOf(card) !== 0),
    indicator = undealt[turned]!;
  const starter = (initial.firstStarter + roundNumber - 1) % seats;
  return {
    roundNumber,
    starter,
    turn: starter,
    phase: 'draw',
    hands: Array.from({ length: seats }, (_, seat) =>
      dealt.filter((_, index) => index % seats === seat),
    ),
    stock: [...undealt.slice(turned + 1), ...undealt.slice(0, turned)],
    discard: [indicator],
    indicator,
    wildRank: game === 'thanasis' ? rankOf(indicator) : null,
    trump: game === 'biriba' ? suitOf(indicator) : null,
    melds: [],
    opened: Array.from({ length: seats }, () => false),
    reserves: Array.from({ length: packets }, (_, packet) =>
      deck.slice(packet * RESERVE_SIZE, (packet + 1) * RESERVE_SIZE),
    ),
    reserveTaken: [false, false],
    reserveWaiting: [null, null],
    pickup: [],
    mustUsePickup: false,
    turnDrawn: null,
  };
}
function roundStarted(state: RummyState): GameEvent {
  return {
    type: 'round-started',
    roundNumber: state.roundNumber,
    starter: state.starter,
    indicator: state.indicator,
    wildRank: state.wildRank,
    trump: state.trump,
  };
}
function root(initial: InitialState): Transition {
  const state: RummyState = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSIONS[initial.game],
    game: initial.game,
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
    events: [{ type: 'game-created', mode: initial.mode }, roundStarted(state)],
  };
}
function penaltyResults(state: RummyState): SideResult[] {
  return state.hands.map((hand, seat) => {
    const handPoints =
      state.game === 'thanasis'
        ? leastPenalty(hand, state)
        : pointsOf(hand, state);
    return {
      side: seat,
      seats: [seat],
      meldPoints: 0,
      bonusPoints: 0,
      handPoints,
      reservePenalty: 0,
      closingBonus: 0,
      points: handPoints,
    };
  });
}
/** A packet still waiting for its first draw costs the flat 100, never its cards. */
function biribaResult(
  state: RummyState,
  side: number,
  closer: number | null,
): SideResult {
  const melds = state.melds.filter((meld) => meld.owner === side),
    seats = [side, side + 2];
  const meldPoints = melds.reduce(
    (sum, meld) =>
      sum +
      pointsOf(
        meld.slots.map((slot) => slot.card),
        state,
      ),
    0,
  );
  const bonusPoints = melds.reduce(
    (sum, meld) => sum + biribaBonus(meld, state.trump),
    0,
  );
  const handPoints = seats
    .filter((seat) => !state.reserveWaiting.includes(seat))
    .reduce((sum, seat) => sum + pointsOf(state.hands[seat]!, state), 0);
  const unused =
    !state.reserveTaken[side] || state.reserveWaiting[side] !== null;
  const reservePenalty = unused ? 100 : 0,
    closingBonus = closer !== null && closer % 2 === side ? 100 : 0;
  return {
    side,
    seats,
    meldPoints,
    bonusPoints,
    handPoints,
    reservePenalty,
    closingBonus,
    points:
      meldPoints + bonusPoints - handPoints - reservePenalty + closingBonus,
  };
}
function roundResults(state: RummyState, closer: number | null): SideResult[] {
  return state.game === 'biriba'
    ? [biribaResult(state, 0, closer), biribaResult(state, 1, closer)]
    : penaltyResults(state);
}
/**
 * The designer's rule for all three games: once the end condition holds, one clear
 * leader wins, and an exact tie for the lead plays another round.
 */
function matchWinner(
  game: GameId,
  scores: readonly number[],
  roundNumber: number,
): number | null {
  const reached =
    game === 'thanasis'
      ? roundNumber >= THANASIS_DEALS
      : Math.max(...scores) >=
        (game === 'koumkan' ? KOUMKAN_LIMIT : BIRIBA_TARGET);
  if (!reached) return null;
  const lead = game === 'biriba' ? Math.max(...scores) : Math.min(...scores);
  const leaders = scores.flatMap((score, side) =>
    score === lead ? [side] : [],
  );
  return leaders.length === 1 ? leaders[0]! : null;
}
const MATCH_REASONS = {
  koumkan: 'limit-reached',
  thanasis: 'deals-completed',
  biriba: 'target-reached',
} as const;
function finishRound(
  state: RummyState,
  closer: number | null,
  events: readonly GameEvent[],
): Transition {
  const results = roundResults(state, closer);
  const scores = state.scores.map(
    (score, side) => score + results[side]!.points,
  );
  const outcome: RoundOutcome = {
    roundNumber: state.roundNumber,
    starter: state.starter,
    reason: closer === null ? 'stock' : 'closed',
    closer,
    melds: state.melds,
    results,
    scores,
  };
  const rounds = [...state.rounds, outcome];
  const ended: GameEvent[] = [...events, { type: 'round-ended', outcome }];
  const winner = matchWinner(state.game, scores, state.roundNumber);
  if (winner === null)
    return {
      state: { ...state, scores, rounds, phase: 'round-end' },
      events: ended,
    };
  const winners = state.initial.players.flatMap((_, seat) =>
    sideOf(state.game, seat) === winner ? [seat] : [],
  );
  const matchOutcome: MatchOutcome = {
    kind: 'win',
    side: winner,
    winners,
    winnerIds: winners.map((seat) => state.initial.players[seat]!),
    reason: MATCH_REASONS[state.game],
    roundNumber: state.roundNumber,
    scores,
  };
  return {
    state: { ...state, scores, rounds, phase: 'ended', matchOutcome },
    events: [...ended, { type: 'match-ended', outcome: matchOutcome }],
  };
}
function passTurn(
  state: RummyState,
  seat: number,
  events: readonly GameEvent[],
): Transition {
  const next: RummyState = {
    ...state,
    turn: (seat + 1) % SEATS[state.game],
    phase: 'draw',
    pickup: [],
    mustUsePickup: false,
    turnDrawn: null,
  };
  return next.stock.length > 0
    ? { state: next, events: [...events] }
    : finishRound(next, null, events);
}
function takeReserve(
  state: RummyState,
  seat: number,
  afterDiscard: boolean,
): RummyState {
  const side = sideOf(state.game, seat);
  return {
    ...state,
    hands: replacedHand(state, seat, state.reserves[side]!),
    reserves: state.reserves.map((packet, index) =>
      index === side ? [] : packet,
    ),
    reserveTaken: state.reserveTaken.map(
      (taken, index) => taken || index === side,
    ),
    reserveWaiting: state.reserveWaiting.map((waiting, index) =>
      index === side && afterDiscard ? seat : waiting,
    ),
  };
}
function reserveEvent(
  state: RummyState,
  seat: number,
  afterDiscard: boolean,
): GameEvent {
  return {
    type: 'reserve-taken',
    playerId: state.initial.players[seat]!,
    seat,
    side: sideOf(state.game, seat),
    afterDiscard,
  };
}
function draw(
  state: RummyState,
  seat: number,
  source: 'stock' | 'discard',
): Transition {
  refuse(drawProblem(state, seat, source));
  const playerId = state.initial.players[seat]!,
    hand = state.hands[seat]!,
    side = sideOf(state.game, seat);
  const drawn: RummyState = {
    ...state,
    phase: 'meld',
    reserveWaiting: state.reserveWaiting.map((waiting, index) =>
      index === side && waiting === seat ? null : waiting,
    ),
  };
  if (source === 'stock') {
    const card = state.stock[0]!;
    return {
      state: {
        ...drawn,
        hands: replacedHand(state, seat, [...hand, card]),
        stock: state.stock.slice(1),
        turnDrawn: card,
      },
      events: [{ type: 'card-drawn', playerId, seat, source, cards: [] }],
    };
  }
  if (state.game === 'biriba')
    return {
      state: {
        ...drawn,
        hands: replacedHand(state, seat, [...hand, ...state.discard]),
        discard: [],
        pickup: state.discard,
        mustUsePickup: true,
      },
      events: [
        { type: 'card-drawn', playerId, seat, source, cards: state.discard },
      ],
    };
  const card = state.discard.at(-1)!;
  return {
    state: {
      ...drawn,
      hands: replacedHand(state, seat, [...hand, card]),
      discard: state.discard.slice(0, -1),
      turnDrawn: card,
    },
    events: [{ type: 'card-drawn', playerId, seat, source, cards: [card] }],
  };
}
/** A hand emptied by a meld or lay-off can only mean a Biriba packet; the checks ruled out the rest. */
function afterPlacement(
  state: RummyState,
  seat: number,
  placed: readonly Card[],
  melds: readonly Meld[],
  event: GameEvent,
): Transition {
  const hand = without(state.hands[seat]!, placed);
  const next: RummyState = {
    ...state,
    melds,
    hands: replacedHand(state, seat, hand),
    mustUsePickup:
      state.mustUsePickup &&
      !placed.some((card) => state.pickup.includes(card)),
  };
  return hand.length > 0
    ? { state: next, events: [event] }
    : {
        state: takeReserve(next, seat, false),
        events: [event, reserveEvent(state, seat, false)],
      };
}
function meld(
  state: RummyState,
  seat: number,
  cards: readonly Card[],
  option: number,
): Transition {
  refuse(meldProblem(state, seat, cards, option));
  const placed = meldFrom(state, seat, meldOptions(cards, state)[option]!);
  return afterPlacement(
    {
      ...state,
      opened: state.opened.map((open, index) => open || index === seat),
    },
    seat,
    cards,
    [...state.melds, placed],
    {
      type: 'meld-placed',
      playerId: state.initial.players[seat]!,
      seat,
      meld: placed,
    },
  );
}
function extend(
  state: RummyState,
  seat: number,
  id: string,
  cards: readonly Card[],
  option: number,
): Transition {
  refuse(extendProblem(state, seat, id, cards, option));
  const target = state.melds.find((item) => item.id === id)!,
    shape = extendOptions(target, cards, state)[option]!,
    melds = withSlots(state.melds, target, shape.slots);
  return afterPlacement(state, seat, cards, melds, {
    type: 'meld-extended',
    playerId: state.initial.players[seat]!,
    seat,
    meld: melds.find((item) => item.id === id)!,
    cards,
  });
}
function replaceJoker(
  state: RummyState,
  seat: number,
  id: string,
  card: Card,
): Transition {
  refuse(replaceProblem(state, seat, id, card));
  const target = state.melds.find((item) => item.id === id)!,
    slot = replacedSlot(target, card)!;
  const slots: MeldSlot[] = target.slots.map((item) =>
    item === slot ? { ...item, card, wild: false } : item,
  );
  const melds = withSlots(state.melds, target, slots);
  const hand = [...without(state.hands[seat]!, [card]), slot.card];
  return {
    state: { ...state, melds, hands: replacedHand(state, seat, hand) },
    events: [
      {
        type: 'joker-replaced',
        playerId: state.initial.players[seat]!,
        seat,
        meld: melds.find((item) => item.id === id)!,
        card,
        joker: slot.card,
      },
    ],
  };
}
function discard(state: RummyState, seat: number, card: Card): Transition {
  refuse(discardProblem(state, seat, card));
  const hand = without(state.hands[seat]!, [card]);
  const next: RummyState = {
    ...state,
    hands: replacedHand(state, seat, hand),
    discard: [...state.discard, card],
  };
  const event: GameEvent = {
    type: 'card-discarded',
    playerId: state.initial.players[seat]!,
    seat,
    card,
  };
  if (hand.length > 0) return passTurn(next, seat, [event]);
  if (state.game === 'biriba' && !state.reserveTaken[sideOf(state.game, seat)])
    return passTurn(takeReserve(next, seat, true), seat, [
      event,
      reserveEvent(state, seat, true),
    ]);
  return finishRound(next, seat, [event]);
}
function close(state: RummyState, seat: number, card: Card): Transition {
  refuse(closeProblem(state, seat, card));
  const hand = state.hands[seat]!;
  const shapes = closingMelds(
    shortMelds(hand, state),
    1 << hand.indexOf(card),
  )!;
  const melds = shapes.map((shape, index) => ({
    ...shape,
    id: `meld-${index}`,
    owner: seat,
  }));
  const next: RummyState = {
    ...state,
    melds,
    hands: replacedHand(state, seat, []),
    discard: [...state.discard, card],
  };
  return finishRound(next, seat, [
    {
      type: 'card-discarded',
      playerId: state.initial.players[seat]!,
      seat,
      card,
    },
  ]);
}
function play(
  state: RummyState,
  seat: number,
  action: Exclude<PlayerAction, { type: 'next' }>,
) {
  switch (action.type) {
    case 'draw':
      return draw(state, seat, action.source);
    case 'meld':
      return meld(state, seat, action.cards, action.option);
    case 'extend':
      return extend(state, seat, action.meld, action.cards, action.option);
    case 'replace':
      return replaceJoker(state, seat, action.meld, action.card);
    case 'discard':
      return discard(state, seat, action.card);
    case 'close':
      return close(state, seat, action.card);
  }
}
function reduce(state: RummyState, record: HistoryRecord): Transition {
  if (state.history.length >= MAX_RECORDS)
    fail('RESOURCE_LIMIT', 'History exceeds the supported record limit.');
  if (state.phase === 'ended') fail('GAME_ENDED', 'The match has ended.');
  const seat = playerSeat(state, record.playerId);
  const counted = {
    ...state,
    revision: state.revision + 1,
    history: [...state.history, record],
  };
  if (record.action.type === 'next') {
    if (state.phase !== 'round-end')
      fail('ILLEGAL_MOVE', 'The round has not ended.');
    const next: RummyState = {
      ...counted,
      ...roundFields(state.initial, state.roundNumber + 1),
    };
    return { state: next, events: [roundStarted(next)] };
  }
  if (state.phase === 'round-end')
    fail('ILLEGAL_MOVE', 'Continue to the next round before playing.');
  if (seat !== state.turn) fail('NOT_YOUR_TURN', 'It is another turn.');
  return play({ ...counted, ply: state.ply + 1 }, seat, record.action);
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
function restore(value: unknown): RummyState {
  if (value && typeof value === 'object' && trusted.has(value))
    return value as RummyState;
  const o = object(value, 'INVALID_STATE');
  if (
    o.schemaVersion !== SCHEMA_VERSION ||
    o.engineVersion !== ENGINE_VERSION ||
    (o.game !== 'koumkan' && o.game !== 'thanasis' && o.game !== 'biriba') ||
    o.rulesVersion !== RULES_VERSIONS[o.game]
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
    keys(o, ['game', 'players', 'seed'], 'INVALID_CONFIG');
    const game = parseGame(o.game),
      seed = parseSeed(o.seed);
    return success(
      root({
        mode: 'standard',
        game,
        players: parsePlayers(o.players, game),
        seed,
        firstStarter: drawFirstStarter(seed, game),
        decks: [],
        scores: Array.from({ length: sideCount(game) }, () => 0),
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
      ['game', 'players', 'seed', 'firstStarter', 'decks', 'scores'],
      'INVALID_CONFIG',
    );
    const game = parseGame(o.game);
    return success(
      root(
        parseInitial({
          ...o,
          mode: 'analysis',
          scores: o.scores ?? Array.from({ length: sideCount(game) }, () => 0),
        }),
      ),
    );
  } catch (error) {
    return reject(error);
  }
}
/** Both humans and bots MUST enter through this same transition function. */
export function applyAction(
  value: RummyState,
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
  value: RummyState,
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
export function getMeldOptions(
  value: RummyState,
  player: string,
  request: MeldOptionsRequest,
): Result<readonly MeldOption[]> {
  try {
    const state = restore(value),
      seat = playerSeat(state, player),
      o = object(request);
    keys(o, ['cards', 'meld']);
    const cards = parseCards(o.cards);
    if (!cards.every((card) => state.hands[seat]!.includes(card)))
      fail('ILLEGAL_MOVE', 'A chosen card is not in hand.');
    if (new Set(cards).size !== cards.length)
      fail('ILLEGAL_MOVE', 'Choose different cards.');
    let shapes = meldOptions(cards, state);
    if (o.meld !== undefined) {
      const id = parseMeldId(o.meld);
      const target = state.melds.find((meld) => meld.id === id);
      if (!target) fail('ILLEGAL_MOVE', 'Choose a meld on the table.');
      shapes = extendOptions(target, cards, state);
    }
    return {
      ok: true,
      value: freeze(shapes.map((shape, option) => ({ ...shape, option }))),
    };
  } catch (error) {
    return reject(error);
  }
}
/** Uses the accepted-action validators without applying a move, deal or score. */
export function previewSelection(
  value: RummyState,
  player: string,
  input: unknown,
): Result<SelectionPreview> {
  try {
    const state = restore(value),
      seat = playerSeat(state, player);
    if (state.phase === 'ended') fail('GAME_ENDED', 'The match has ended.');
    if (state.phase !== 'meld')
      fail('ILLEGAL_MOVE', 'Draw before selecting a play.');
    if (state.turn !== seat) fail('NOT_YOUR_TURN', 'It is the other turn.');
    const o = object(input);
    keys(o, ['cards', 'meld']);
    const cards = parseCards(o.cards);
    if (
      new Set(cards).size !== cards.length ||
      !cards.every((card) => state.hands[seat]!.includes(card))
    )
      fail('INVALID_ACTION', 'Choose distinct cards from your own hand.');
    const id = o.meld === undefined ? undefined : parseMeldId(o.meld);
    const target =
      id === undefined ? undefined : state.melds.find((m) => m.id === id);
    if (id !== undefined && !target)
      fail('INVALID_ACTION', 'Choose a current table meld.');
    const shapes = target
      ? extendOptions(target, cards, state)
      : meldOptions(cards, state);
    return {
      ok: true,
      value: freeze({
        selection: { cards, ...(id === undefined ? {} : { meld: id }) },
        options: shapes.map((shape, option) => ({
          ...shape,
          option,
          legal: !(id === undefined
            ? meldProblem(state, seat, cards, option)
            : extendProblem(state, seat, id, cards, option)),
        })),
        discard: cards.length === 1 && !discardProblem(state, seat, cards[0]!),
        replace:
          cards.length === 1 &&
          id !== undefined &&
          !replaceProblem(state, seat, id, cards[0]!),
      }),
    };
  } catch (error) {
    return reject(error);
  }
}
export function getObservation(
  value: RummyState,
  viewer: string | null,
): Result<RummyObservation> {
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
        game: state.game,
        rulesVersion: state.rulesVersion,
        revision: state.revision,
        viewer,
        viewerSeat,
        players: state.initial.players,
        ply: state.ply,
        roundNumber: state.roundNumber,
        starter: state.starter,
        turn: state.turn,
        phase: state.phase,
        hand: viewerSeat === null ? [] : state.hands[viewerSeat]!,
        handCounts: state.hands.map((hand) => hand.length),
        stockCount: state.stock.length,
        discard: state.discard,
        indicator: state.indicator,
        wildRank: state.wildRank,
        trump: state.trump,
        melds: state.melds,
        opened: state.opened,
        reserveCounts: state.reserves.map((packet) => packet.length),
        reserveTaken: state.reserveTaken,
        pickup: state.pickup,
        mustUsePickup: state.mustUsePickup,
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
export function serializeState(value: RummyState): Result<string> {
  try {
    return { ok: true, value: JSON.stringify(restore(value)) };
  } catch (error) {
    return reject(error);
  }
}
export function restoreState(value: unknown): Result<RummyState> {
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
export function replay(initial: unknown, records: unknown): Result<RummyState> {
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
export function isGameOver(value: RummyState): Result<boolean> {
  try {
    return { ok: true, value: restore(value).phase === 'ended' };
  } catch (error) {
    return reject(error);
  }
}
