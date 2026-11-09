import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as xeri from '#engines/xeri';
import * as diloti from '#engines/diloti';
import { DilotiGameRuntime, XeriGameRuntime } from './card-game-runtime';

const participants = [
  { userId: 'second-player', seat: 1 },
  { userId: 'first-player', seat: 0 },
] as const;
type Observation = xeri.XeriObservation | diloti.DilotiObservation;

for (const [game, runtime, engine] of [
  ['xeri', new XeriGameRuntime(), xeri],
  ['diloti', new DilotiGameRuntime(), diloti],
] as const) {
  void describe(`${game} table runtime`, () => {
    const create = () =>
      runtime.start({ gameId: game, formatId: 'standard', participants });

    void it('binds seat order and draws a fresh server-only seed', () => {
      const first = create(),
        second = create();
      assert.equal(first.rulesVersion, engine.RULES_VERSION);
      assert.equal(runtime.version, engine.ENGINE_VERSION);
      assert.deepEqual(first.state.initial.players, [
        'first-player',
        'second-player',
      ]);
      assert.match(first.state.initial.seed, /^[a-f0-9]{64}$/);
      assert.notEqual(first.state.initial.seed, second.state.initial.seed);
      assert.throws(
        () => runtime.start({ gameId: game, formatId: 'other', participants }),
        { code: 'engine_unavailable' },
      );
      assert.throws(
        () =>
          runtime.start({
            gameId: game,
            formatId: 'standard',
            participants: [participants[0], participants[0]],
          }),
        { code: 'platform_unavailable' },
      );
    });

    void it('projects only the requesting participant hand and public counts', () => {
      const { state } = create();
      for (const userId of state.initial.players) {
        const view = runtime.observe({ state, userId }) as Observation,
          ownSeat = state.initial.players.indexOf(userId) as 0 | 1;
        assert.deepEqual(view.hand, state.hands[ownSeat]);
        assert.deepEqual(view.handCounts, [6, 6]);
        assert.equal(view.stockCount, 36);
        const encoded = JSON.stringify(view);
        assert.equal(encoded.includes(state.initial.seed), false);
        for (const privateKey of ['initial', 'hands', 'stock', 'captured'])
          assert.equal(Object.hasOwn(view, privateKey), false);
      }
      assert.throws(() => runtime.observe({ state, userId: 'outsider' }), {
        code: 'not_participating',
      });
    });

    void it('applies a legal card from restored state without mutating it', () => {
      const { state } = create(),
        saved = JSON.stringify(state),
        userId = state.initial.players[state.turn],
        view = runtime.observe({ state, userId }) as Observation;
      const accepted = runtime.apply({
        state: JSON.parse(saved) as unknown,
        userId,
        action: view.legalActions[0],
        participants,
      });
      assert.equal(accepted.gameplay, true);
      assert.equal(accepted.state.ply, 1);
      assert.equal(accepted.state.revision, 1);
      assert.equal(accepted.outcome, undefined);
      assert.equal(JSON.stringify(state), saved);
    });

    void it('rejects spoofed actions, actors and changed roster bindings', () => {
      const { state } = create(),
        userId = state.initial.players[state.turn],
        view = runtime.observe({ state, userId }) as Observation,
        saved = JSON.stringify(state);
      assert.throws(
        () =>
          runtime.apply({
            state,
            userId,
            action: { ...view.legalActions[0], winnerId: userId },
            participants,
          }),
        { code: 'invalid_game_action' },
      );
      assert.throws(
        () =>
          runtime.apply({
            state,
            userId: 'outsider',
            action: view.legalActions[0],
            participants,
          }),
        { code: 'not_participating' },
      );
      assert.throws(
        () =>
          runtime.apply({
            state,
            userId,
            action: view.legalActions[0],
            participants: [
              { userId: 'first-player', seat: 1 },
              { userId: 'second-player', seat: 0 },
            ],
          }),
        { code: 'platform_unavailable' },
      );
      assert.equal(JSON.stringify(state), saved);
    });

    void it('refuses unsupported, tampered and analysis snapshots', () => {
      const { state } = create();
      for (const changed of [
        { ...state, scores: [1000, 0] },
        { ...state, initial: { ...state.initial, seed: '0'.repeat(64) } },
      ])
        assert.throws(
          () => runtime.observe({ state: changed, userId: 'first-player' }),
          { code: 'platform_unavailable' },
        );
      assert.throws(
        () =>
          runtime.observe({
            state: { ...state, engineVersion: 'unsupported' },
            userId: 'first-player',
          }),
        { code: 'engine_unavailable' },
      );
      const analysis = engine.createAnalysisGame({
        players: ['first-player', 'second-player'],
        seed: '0'.repeat(64),
        firstDealer: 0,
        decks: [engine.DECK],
      });
      assert.equal(analysis.ok, true);
      if (!analysis.ok) throw new Error('Analysis fixture failed');
      assert.throws(
        () =>
          runtime.observe({ state: analysis.state, userId: 'first-player' }),
        { code: 'platform_unavailable' },
      );
    });

    void it('preserves the score screen until next, without counting it as a card', () => {
      const created = engine.createGame({
        players: ['first-player', 'second-player'],
        seed: '0'.repeat(64),
      });
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error('Standard fixture failed');
      let state = created.state;
      for (let card = 0; card < 48; card++) {
        const userId = state.initial.players[state.turn],
          view = runtime.observe({ state, userId }) as Observation;
        const accepted = runtime.apply({
          state,
          userId,
          action: view.legalActions[0],
          participants,
        });
        assert.equal(accepted.gameplay, true);
        state = accepted.state;
      }
      assert.equal(state.phase, 'round-end');
      assert.equal(state.rounds.length, 1);
      assert.equal(state.ply, 48);
      for (const userId of state.initial.players) {
        const view = runtime.observe({ state, userId }) as Observation;
        assert.deepEqual(view.legalActions, [{ type: 'next' }]);
      }
      const accepted = runtime.apply({
        state: JSON.parse(JSON.stringify(state)) as unknown,
        userId: 'first-player',
        action: { type: 'next' },
        participants,
      });
      assert.equal(accepted.gameplay, false);
      assert.equal(accepted.state.ply, 48);
      assert.equal(accepted.state.revision, state.revision + 1);
      assert.equal(accepted.state.phase, 'playing');
      assert.equal(accepted.state.roundNumber, 2);
      assert.equal(accepted.state.rounds.length, 1);
    });
  });
}

void it('Diloti previews validate private standard state and never apply a transition', () => {
  const runtime = new DilotiGameRuntime();
  const { state } = runtime.start({
    gameId: 'diloti',
    formatId: 'standard',
    participants,
  });
  const saved = JSON.stringify(state),
    userId = state.initial.players[state.turn];
  const selection = { card: state.hands[state.turn][0]!, table: [] };
  const p = runtime.preview({
    state: JSON.parse(saved) as unknown,
    userId,
    selection,
  });
  assert.equal(p.declarations.length, 10);
  assert.deepEqual(p.selection, selection);
  assert.equal(JSON.stringify(state), saved);
  assert.equal(JSON.stringify(p).includes(state.initial.seed), false);
  assert.throws(
    () => runtime.preview({ state, userId: 'outsider', selection }),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () =>
      runtime.preview({
        state: { ...state, hands: [[], []] },
        userId,
        selection,
      }),
    { code: 'platform_unavailable' },
  );
});
