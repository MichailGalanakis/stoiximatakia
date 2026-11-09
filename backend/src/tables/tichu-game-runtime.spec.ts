import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as tichu from '#engines/tichu';
import { TichuGameRuntime } from './card-game-runtime';
import { tichuMove } from '../../test/tichu-play';
const runtime = new TichuGameRuntime(),
  participants = [0, 1, 2, 3].map((seat) => ({
    seat,
    userId: `player-${seat}`,
  }));
const start = (formatId = 'single') =>
  runtime.start({ gameId: 'tichu', formatId, participants }).state;
const apply = (state: tichu.TichuState, user: number, action: unknown) =>
  runtime.apply({
    state,
    userId: participants[user]!.userId,
    action,
    participants,
  }).state;
const view = (state: tichu.TichuState, user: number) =>
  runtime.observe({
    state,
    userId: participants[user]!.userId,
  }) as tichu.TichuObservation & { lastPlay: { action: unknown } };
void test('Tichu start binds four distinct permanent seats, versions and all three formats', () => {
  for (const format of ['single', '500', '1000']) {
    const s = start(format);
    assert.equal(s.initial.format, format);
    assert.equal(s.initial.mode, 'standard');
    assert.equal(s.schemaVersion, 2);
    assert.equal(s.engineVersion, '0.2.0');
    assert.deepEqual(
      s.hands.map((h) => h.length),
      [8, 8, 8, 8],
    );
    assert.match(s.initial.seed, /^[a-f0-9]{64}$/);
  }
  for (const formatId of ['standard', 'bad'])
    assert.throws(() => start(formatId));
  for (const p of [
    participants.slice(0, 3),
    [...participants.slice(0, 3), { seat: 3, userId: 'player-0' }],
    [...participants.slice(0, 3), { seat: 4, userId: 'other' }],
  ])
    assert.throws(() =>
      runtime.start({ gameId: 'tichu', formatId: 'single', participants: p }),
    );
});
void test('Tichu private projections and exchange receipts never carry committed cards or other hands', () => {
  let s = start();
  for (let seat = 0; seat < 4; seat++) {
    const v = view(s, seat);
    assert.deepEqual(v.hand, s.hands[seat]);
    assert.equal(v.turn, null);
    assert.equal(v.yourMove, true);
    for (const key of [
      'hands',
      'stock',
      'exchange',
      'initial',
      'seed',
      'history',
      'windowPending',
    ])
      assert.ok(!(key in v));
    s = apply(s, seat, { type: 'grand', call: false });
  }
  const cards = s.hands[0]!.slice(0, 3);
  s = apply(s, 0, { type: 'exchange', cards });
  for (let seat = 0; seat < 4; seat++) {
    const v = view(s, seat);
    assert.deepEqual(v.lastPlay.action, { type: 'exchange' });
    assert.deepEqual(v.exchangeCommitted, [true, false, false, false]);
  }
  const altered = participants.map((p) =>
    p.seat === 3 ? { ...p, userId: 'replacement' } : p,
  );
  assert.throws(() =>
    runtime.apply({
      state: s,
      userId: 'player-0',
      action: { type: 'declare' },
      participants: altered,
    }),
  );
  assert.throws(() => runtime.observe({ state: s, userId: 'outsider' }));
});
void test('Tichu refuses analysis, old contracts, tampering and checks exact selections without state mutation', () => {
  let s = start();
  const analysis = tichu.createAnalysisGame({
    players: participants.map((p) => p.userId),
    seed: '0'.repeat(64),
    format: 'single',
    decks: [tichu.DECK],
  });
  assert.ok(analysis.ok);
  assert.throws(() =>
    runtime.observe({ state: analysis.state, userId: 'player-0' }),
  );
  const old = { ...s, engineVersion: '0.1.0', schemaVersion: 1 };
  assert.throws(() => view(old as tichu.TichuState, 0));
  assert.throws(() => view({ ...s, ply: 99 }, 0));
  for (let seat = 0; seat < 4; seat++)
    s = apply(s, seat, { type: 'grand', call: false });
  for (let seat = 0; seat < 4; seat++)
    s = apply(s, seat, { type: 'exchange', cards: s.hands[seat]!.slice(0, 3) });
  const seat = s.turn!,
    v = view(s, seat),
    a = v.legalActions.find((a) => a.type === 'play');
  assert.ok(a?.type === 'play');
  const before = JSON.stringify(s),
    selection = {
      cards: a.cards,
      ...(a.wish === undefined ? {} : { wish: a.wish }),
    };
  const p = runtime.preview({
    state: s,
    userId: participants[seat]!.userId,
    selection,
  });
  assert.ok(p.options.some((o) => o.option === a.option && o.legal));
  assert.equal(JSON.stringify(s), before);
  assert.throws(() =>
    runtime.preview({
      state: s,
      userId: participants[seat]!.userId,
      selection: { cards: ['bad'] },
    }),
  );
});
for (const format of ['single', '500', '1000'] as const)
  void test(`normal ${format} Tichu match retains rounds, replays and reports both partnership winners`, () => {
    const created = tichu.createGame({
      players: participants.map((p) => p.userId),
      seed: '0'.repeat(64),
      format,
    });
    assert.ok(created.ok);
    let s = created.state,
      actions = 0,
      nexts = 0;
    let outcome;
    for (let n = 0; n < 15000 && !s.matchOutcome; n++) {
      let moved = false;
      for (let seat = 0; seat < 4; seat++) {
        const v = view(s, seat),
          a = tichuMove(v);
        if (!a) continue;
        const before = s;
        const accepted = runtime.apply({
          state: s,
          userId: participants[seat]!.userId,
          action: a,
          participants,
        });
        s = accepted.state;
        outcome = accepted.outcome;
        assert.equal(s.ply - before.ply, a.type === 'next' ? 0 : 1);
        if (a.type === 'next') {
          nexts++;
          assert.deepEqual(s.scores, before.scores);
        } else actions++;
        moved = true;
        break;
      }
      assert.ok(moved);
    }
    assert.ok(s.matchOutcome);
    assert.equal(outcome?.kind, 'win');
    assert.deepEqual(outcome?.winnerUserIds, s.matchOutcome.winnerIds);
    assert.equal(s.matchOutcome.winners.length, 2);
    assert.equal(
      s.matchOutcome.winners[0]! % 2,
      s.matchOutcome.winners[1]! % 2,
    );
    assert.ok(actions > 0);
    if (format !== 'single') assert.ok(nexts > 0);
    assert.ok(tichu.restoreState(JSON.parse(JSON.stringify(s))).ok);
  });
