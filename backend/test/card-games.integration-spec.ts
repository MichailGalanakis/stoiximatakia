import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool, type PoolClient } from 'pg';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import type { MatchSummary } from '../src/tables/match-lifecycle';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import {
  PlatformStore,
  type TableSnapshot,
} from '../src/tables/platform.store';

type CardGame = 'xeri' | 'diloti' | 'koumkan' | 'thanasis';
type Action = Record<string, unknown>;
interface Observation {
  game: CardGame;
  revision: number;
  viewer: string;
  viewerSeat: 0 | 1;
  players: [string, string];
  ply: number;
  roundNumber: number;
  turn: 0 | 1;
  phase: 'playing' | 'draw' | 'meld' | 'round-end' | 'ended';
  hand: string[];
  handCounts: [number, number];
  stockCount: number;
  capturedCounts: [number, number];
  scores: [number, number];
  rounds: { roundNumber: number }[];
  legalActions: Action[];
  matchOutcome: { winnerId?: string; winnerIds?: string[] } | null;
}
interface GameResponse {
  game: {
    status: 'playing' | 'completed' | 'cancelled';
    revision: number;
    engineVersion: string;
    rulesVersion: string;
    observation: Observation;
  };
  match: MatchSummary;
}
interface CommandResponse extends GameResponse {
  table: TableSnapshot;
  balance: { availableMinor: number; reservedMinor: number };
}

void describe('real Xeri, Diloti, Koum Kan and Thanasis table integrations', () => {
  let admin: Pool, pool: Pool, app: NestFastifyApplication, url: string;
  const schema = 'cards_' + randomUUID().replaceAll('-', ''),
    origin = 'https://cards.skillbetting.invalid';
  const sockets = new Set<WebSocket>();

  async function application(registry?: GameRuntimeRegistry) {
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'isolated-card-test-secret'.repeat(3) })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      });
    if (registry)
      builder.overrideProvider(GameRuntimeRegistry).useValue(registry);
    const module = await builder.compile();
    const instance = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(instance, {
      log: () => {},
      warn: () => {},
      error: () => {},
    });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    await instance.listen(0, '127.0.0.1');
    return instance;
  }
  before(async () => {
    const target = new URL(process.env.TEST_DATABASE_URL ?? '');
    assert.match(target.pathname, /_test$/);
    admin = new Pool({ connectionString: target.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    url = target.href;
    pool = new Pool({ connectionString: url });
    for (const file of (await readdir('migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort())
      await pool.query(await readFile('migrations/' + file, 'utf8'));
    app = await application();
  });
  after(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function player() {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at) VALUES($1,$2,$2,'test-only',$3,$4,'demo',null,null)`,
      [
        id,
        'C_' + id.replaceAll('-', '').slice(0, 20),
        id + '@demo.invalid',
        'demo:' + id,
      ],
    );
    await pool.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [tokenDigest(token), id],
    );
    return { id, token, cookie: '__Host-sb_session=' + token };
  }
  type Player = Awaited<ReturnType<typeof player>>;
  const post = (p: Player, path: string, payload: unknown, target = app) =>
    target.inject({
      method: 'POST',
      url: '/multiplayer/v1/' + path,
      headers: {
        origin,
        'x-skillbetting-client': 'web-v1',
        cookie: p.cookie,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  const get = (p: Player, path: string, target = app) =>
    target.inject({
      method: 'GET',
      url: '/multiplayer/v1/' + path,
      headers: { cookie: p.cookie },
    });
  async function view(p: Player, tableId: string, target = app) {
    const response = await get(p, `tables/${tableId}/game`, target);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    return response.json<GameResponse>();
  }
  async function started(game: CardGame, privateCode?: string) {
    const a = await player(),
      b = await player();
    const created = await post(a, 'tables', {
      operationId: randomUUID(),
      gameId: game,
      name: 'Real cards test',
      visibility: privateCode ? 'private' : 'public',
      ...(privateCode ? { accessCode: privateCode } : {}),
      formatId: 'standard',
      prizeContributionMinor: 100,
    });
    assert.equal(created.statusCode, 201, created.body);
    const tableId = created.json<{ table: TableSnapshot }>().table.id;
    if (privateCode)
      assert.equal(
        (await post(b, 'private-access', { code: privateCode })).statusCode,
        201,
      );
    assert.equal(
      (
        await post(b, `tables/${tableId}/seats`, {
          operationId: randomUUID(),
          seatIndex: 1,
        })
      ).statusCode,
      201,
    );
    for (const p of [a, b]) {
      const response = await post(p, `tables/${tableId}/ready`, {
        operationId: randomUUID(),
      });
      assert.equal(response.statusCode, 201, response.body);
    }
    return { a, b, players: [a, b] as const, tableId };
  }
  function mover(players: readonly [Player, Player], observation: Observation) {
    return players[observation.turn];
  }
  async function move(
    p: Player,
    tableId: string,
    current: GameResponse,
    action: Action,
    operationId: string = randomUUID(),
    target = app,
  ) {
    return post(
      p,
      `tables/${tableId}/actions`,
      { operationId, expectedRevision: current.game.revision, action },
      target,
    );
  }
  async function stored(tableId: string) {
    return (
      await pool.query<{
        state: Observation & { initial: { seed: string }; hands: string[][] };
        revision: number;
        accepted_gameplay_count: number;
        engine_version: string;
        rules_version: string;
      }>('SELECT * FROM table_games WHERE table_id=$1', [tableId])
    ).rows[0]!;
  }
  async function reconciled(tableId: string) {
    assert.equal(
      (
        await pool.query(
          `SELECT 1 FROM credit_accounts a WHERE balance_minor<>(SELECT coalesce(sum(amount_minor),0) FROM credit_postings p WHERE p.account_key=a.key)`,
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_settlements WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      1,
    );
  }

  for (const game of ['xeri', 'diloti', 'koumkan', 'thanasis'] as const) {
    void it(`${game}: starts a version-pinned, funded match with distinct private player views`, async () => {
      const { a, b, tableId } = await started(game),
        first = await view(a, tableId),
        second = await view(b, tableId),
        record = await stored(tableId);
      assert.equal(first.game.revision, 1);
      assert.equal(first.match.revision, 1);
      assert.equal(first.game.observation.revision, 0);
      assert.equal(first.game.observation.viewer, a.id);
      assert.equal(second.game.observation.viewer, b.id);
      assert.equal(first.game.observation.viewerSeat, 0);
      assert.equal(second.game.observation.viewerSeat, 1);
      assert.deepEqual(first.game.observation.players, [a.id, b.id]);
      assert.deepEqual(first.game.observation.hand, record.state.hands[0]);
      assert.deepEqual(second.game.observation.hand, record.state.hands[1]);
      assert.equal(
        first.game.observation.hand.length,
        game === 'koumkan' || game === 'thanasis' ? 10 : 6,
      );
      assert.equal(
        first.game.observation.stockCount,
        game === 'thanasis' ? 31 : game === 'koumkan' ? 85 : 36,
      );
      assert.equal(
        first.game.engineVersion,
        game === 'koumkan' || game === 'thanasis' ? '0.1.0' : '0.2.0',
      );
      assert.match(
        first.game.rulesVersion,
        game === 'koumkan' || game === 'thanasis' ? /\.v1$/ : /\.v2$/,
      );
      assert.equal(record.engine_version, first.game.engineVersion);
      assert.equal(record.rules_version, first.game.rulesVersion);
      for (const response of [first, second]) {
        const body = JSON.stringify(response);
        assert.ok(!body.includes(record.state.initial.seed));
        for (const secret of ['initial', 'seed', 'stock', 'hands', 'captured'])
          assert.ok(!(secret in response.game.observation));
        assert.equal(response.match.hasGameplay, false);
        assert.equal(response.match.outcome, null);
      }
      const history = await pool.query<{
        payload: { initialState: unknown };
      }>(
        "SELECT payload FROM match_events WHERE table_id=$1 AND kind='start'",
        [tableId],
      );
      assert.deepEqual(history.rows[0]!.payload.initialState, record.state);
      const roster = await pool.query<{ user_id: string; seat_index: number }>(
        'SELECT user_id,seat_index FROM match_roster WHERE table_id=$1 ORDER BY seat_index',
        [tableId],
      );
      assert.deepEqual(roster.rows, [
        { user_id: a.id, seat_index: 0 },
        { user_id: b.id, seat_index: 1 },
      ]);
    });
  }

  void it('rejects strangers, wrong turns, spoofed actors, malformed actions and unsafe origins without changing state', async () => {
    const { a, b, players, tableId } = await started('xeri'),
      outsider = await player(),
      current = await view(a, tableId),
      active = mover(players, current.game.observation),
      inactive = active === a ? b : a,
      mine = await view(active, tableId),
      action = mine.game.observation.legalActions[0]!;
    assert.equal(
      (await get(outsider, `tables/${tableId}/game`)).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/multiplayer/v1/tables/${tableId}/game`,
        })
      ).statusCode,
      401,
    );
    const invalid = [
      move(outsider, tableId, mine, action),
      move(inactive, tableId, mine, action),
      move(active, tableId, mine, { ...action, playerId: inactive.id }),
      move(active, tableId, mine, { type: 'play-card', card: 'forged' }),
      post(active, `tables/${tableId}/actions`, {
        operationId: randomUUID(),
        expectedRevision: 1,
        action,
        winnerId: active.id,
      }),
      post(active, `tables/${tableId}/actions`, {
        operationId: randomUUID(),
        expectedRevision: '1',
        action,
      }),
      post(active, `tables/${tableId}/actions`, {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: [],
      }),
      app.inject({
        method: 'POST',
        url: `/multiplayer/v1/tables/${tableId}/actions`,
        headers: {
          origin: 'https://untrusted.invalid',
          cookie: active.cookie,
          'x-skillbetting-client': 'web-v1',
        },
        payload: { operationId: randomUUID(), expectedRevision: 1, action },
      }),
    ];
    for (const response of await Promise.all(invalid))
      assert.ok([400, 403, 409].includes(response.statusCode), response.body);
    assert.deepEqual(await view(a, tableId), current);
    assert.equal((await stored(tableId)).accepted_gameplay_count, 0);
  });

  void it('uses platform revisions, deduplicates exact retries and permits only one concurrent card play', async () => {
    const { a, players, tableId } = await started('xeri'),
      initial = await view(a, tableId),
      active = mover(players, initial.game.observation),
      current = await view(active, tableId),
      action = current.game.observation.legalActions[0]!,
      operationId = randomUUID();
    const [one, two] = await Promise.all([
      move(active, tableId, current, action, operationId),
      move(active, tableId, current, action, operationId),
    ]);
    assert.equal(one.statusCode, 201, one.body);
    assert.equal(two.statusCode, 201, two.body);
    assert.deepEqual(one.json(), two.json());
    assert.equal(one.json<CommandResponse>().game.revision, 2);
    assert.equal(one.json<CommandResponse>().game.observation.revision, 1);
    const conflict = await move(
      active,
      tableId,
      current,
      { type: 'next' },
      operationId,
    );
    assert.equal(conflict.json<{ code: string }>().code, 'operation_conflict');
    const stale = await move(active, tableId, current, action);
    assert.equal(stale.json<{ code: string }>().code, 'stale_game_revision');
    const next = await view(
        mover(players, one.json<CommandResponse>().game.observation),
        tableId,
      ),
      nextPlayer = mover(players, next.game.observation),
      nextAction = next.game.observation.legalActions[0]!;
    const raced = await Promise.all([
      move(nextPlayer, tableId, next, nextAction),
      move(nextPlayer, tableId, next, nextAction),
    ]);
    assert.deepEqual(raced.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal((await stored(tableId)).accepted_gameplay_count, 2);
    assert.equal((await stored(tableId)).revision, 3);
    const cancel = await post(a, `tables/${tableId}/cancel`, {
      operationId: randomUUID(),
    });
    assert.equal(
      cancel.json<{ code: string }>().code,
      'cancellation_unavailable',
    );
  });

  void it('commits either the first real card or zero-gameplay cancellation atomically', async () => {
    const { a, players, tableId } = await started('xeri'),
      initial = await view(a, tableId),
      active = mover(players, initial.game.observation),
      current = await view(active, tableId);
    const [played, cancelled] = await Promise.all([
      move(active, tableId, current, current.game.observation.legalActions[0]!),
      post(a, `tables/${tableId}/cancel`, { operationId: randomUUID() }),
    ]);
    assert.deepEqual(
      [played.statusCode, cancelled.statusCode].sort(),
      [201, 409],
    );
    const record = await stored(tableId),
      latest = await view(a, tableId);
    if (played.statusCode === 201) {
      assert.equal(record.accepted_gameplay_count, 1);
      assert.equal(latest.game.status, 'playing');
      assert.equal(latest.match.outcome, null);
      assert.equal(
        cancelled.json<{ code: string }>().code,
        'cancellation_unavailable',
      );
    } else {
      assert.equal(record.accepted_gameplay_count, 0);
      assert.equal(latest.game.status, 'cancelled');
      assert.equal(latest.match.outcome!.kind, 'cancel');
      assert.equal(played.json<{ code: string }>().code, 'match_ended');
      await reconciled(tableId);
    }
  });

  void it('preserves a real Diloti action and player projection across a fresh backend instance', async () => {
    const { a, players, tableId } = await started('diloti'),
      initial = await view(a, tableId),
      active = mover(players, initial.game.observation),
      current = await view(active, tableId);
    const accepted = await move(
      active,
      tableId,
      current,
      current.game.observation.legalActions[0]!,
    );
    assert.equal(accepted.statusCode, 201, accepted.body);
    const beforeRestart = await view(active, tableId),
      second = await application();
    try {
      assert.deepEqual(await view(active, tableId, second), beforeRestart);
      const retry = await post(
        active,
        `tables/${tableId}/actions`,
        {
          operationId: randomUUID(),
          expectedRevision: 1,
          action: { type: 'next' },
        },
        second,
      );
      assert.equal(retry.json<{ code: string }>().code, 'stale_game_revision');
    } finally {
      await second.close();
    }
    for (const outdated of [false, true]) {
      const registry = new GameRuntimeRegistry();
      if (outdated)
        registry.register('diloti', {
          version: 'unsupported-old-version',
          start: () => {
            throw new Error('Wrong version must never initialize');
          },
          observe: () => {
            throw new Error('Wrong version must never observe');
          },
        });
      const unavailable = await application(registry);
      try {
        const response = await get(
          active,
          `tables/${tableId}/game`,
          unavailable,
        );
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(
          response.json<{ code: string }>().code,
          'engine_unavailable',
        );
        assert.deepEqual(await view(active, tableId), beforeRestart);
      } finally {
        await unavailable.close();
      }
    }
  });

  async function live(p: Player) {
    const socket = new WebSocket(
      (await app.getUrl()).replace('http:', 'ws:') + '/multiplayer/v1/live',
      { headers: { origin, cookie: p.cookie } },
    );
    sockets.add(socket);
    const messages: Record<string, unknown>[] = [];
    socket.on('message', (data) => {
      assert.ok(Buffer.isBuffer(data));
      messages.push(
        JSON.parse(data.toString('utf8')) as Record<string, unknown>,
      );
    });
    await once(socket, 'open');
    function waitFor(predicate: (message: Record<string, unknown>) => boolean) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.off('message', check);
          reject(new Error('Expected real-card websocket response'));
        }, 5000);
        function check() {
          const found = messages.find(predicate);
          if (!found) return;
          clearTimeout(timeout);
          socket.off('message', check);
          resolve(found);
        }
        socket.on('message', check);
        check();
      });
    }
    return {
      messages,
      waitFor,
      send: (value: unknown) => socket.send(JSON.stringify(value)),
      close: async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const done = once(socket, 'close');
        socket.close();
        await done;
        sockets.delete(socket);
      },
    };
  }

  async function subscribe(
    connection: Awaited<ReturnType<typeof live>>,
    gameId: CardGame,
    tableId: string,
  ) {
    const id = randomUUID();
    connection.send({ id, type: 'subscribe', gameId, tableId });
    const response = await connection.waitFor((message) => message.id === id);
    if (response.type === 'snapshot') return response;
    // A refresh already in flight acknowledges the subscription before its
    // generation-checked snapshot arrives without the command id.
    assert.equal(response.type, 'result');
    assert.deepEqual(response.result, { subscribed: true });
    return connection.waitFor(
      (message) =>
        message.type === 'snapshot' &&
        (message.table as { id?: unknown } | undefined)?.id === tableId,
    );
  }

  void it('keeps public spectators out of HTTP and websocket player projections', async () => {
    const { a, tableId } = await started('xeri'),
      stranger = await player(),
      connection = await live(stranger);
    try {
      const response = await subscribe(connection, 'xeri', tableId);
      assert.equal(response.type, 'snapshot');
      const body = JSON.stringify(response);
      assert.ok(!body.includes('observation'));
      assert.ok(!body.includes('"game":'));
      assert.equal(
        (await get(stranger, `tables/${tableId}/game`)).statusCode,
        403,
      );
      const participantView = await view(a, tableId),
        state = await stored(tableId);
      assert.ok(!body.includes(state.state.initial.seed));
      assert.ok(
        !body.includes(JSON.stringify(participantView.game.observation.hand)),
      );
    } finally {
      await connection.close();
    }
  });

  void it('private-code access grants table viewing but no game state or action authority', async () => {
    const code = 'Private' + randomBytes(6).toString('hex'),
      { a, tableId } = await started('diloti', code),
      visitor = await player();
    assert.equal(
      (await post(visitor, 'private-access', { code })).statusCode,
      201,
    );
    const table = await get(visitor, `tables/${tableId}`);
    assert.equal(table.statusCode, 200);
    assert.ok(!('game' in table.json<Record<string, unknown>>()));
    assert.equal(
      (await get(visitor, `tables/${tableId}/game`)).statusCode,
      403,
    );
    const current = await view(a, tableId),
      action = await move(visitor, tableId, current, { type: 'next' });
    assert.equal(action.statusCode, 403, action.body);
    const connection = await live(visitor);
    try {
      const response = await subscribe(connection, 'diloti', tableId);
      assert.ok(!JSON.stringify(response).includes('observation'));
    } finally {
      await connection.close();
    }
  });

  void it('websocket actions update each participant privately and explicit forfeit overrides the still-playing engine', async () => {
    const { a, b, players, tableId } = await started('xeri'),
      initial = await view(a, tableId),
      active = mover(players, initial.game.observation),
      other = active === a ? b : a,
      current = await view(active, tableId),
      activeSocket = await live(active),
      otherSocket = await live(other);
    try {
      for (const connection of [activeSocket, otherSocket]) {
        const subscribed = await subscribe(connection, 'xeri', tableId);
        assert.ok(JSON.stringify(subscribed).includes('observation'));
      }
      const id = randomUUID(),
        operationId = randomUUID();
      activeSocket.send({
        id,
        type: 'action',
        tableId,
        payload: {
          operationId,
          expectedRevision: current.game.revision,
          action: current.game.observation.legalActions[0],
        },
      });
      const accepted = await activeSocket.waitFor((m) => m.id === id);
      assert.equal(accepted.type, 'result');
      const fresh = await view(other, tableId);
      assert.equal(fresh.game.revision, 2);
      const pushed = await otherSocket.waitFor(
        (m) =>
          m.type === 'snapshot' &&
          (m.game as { revision?: unknown } | undefined)?.revision === 2,
      );
      assert.ok(
        JSON.stringify(pushed).includes(
          JSON.stringify(fresh.game.observation.hand),
        ),
      );
      assert.ok(
        !JSON.stringify(pushed).includes(
          (await stored(tableId)).state.initial.seed,
        ),
      );
      await activeSocket.close();
      assert.equal((await view(other, tableId)).match.outcome, null);
      const forfeit = await post(other, `tables/${tableId}/forfeit`, {
        operationId: randomUUID(),
        expectedRevision: fresh.game.revision,
      });
      assert.equal(forfeit.statusCode, 201, forfeit.body);
      const terminal = await view(active, tableId);
      assert.deepEqual(terminal.match.outcome!.winnerUserIds, [active.id]);
      assert.equal(terminal.match.outcome!.reason, 'explicit-forfeit');
      assert.equal(terminal.game.revision, 3);
      assert.equal(terminal.game.status, 'completed');
      assert.equal((await stored(tableId)).state.phase, 'playing');
      const late = await move(active, tableId, terminal, { type: 'next' });
      assert.equal(late.json<{ code: string }>().code, 'match_ended');
      await reconciled(tableId);
    } finally {
      await activeSocket.close();
      await otherSocket.close();
    }
  });

  void it('keeps live balances and room results coherent while a competing settlement waits for the snapshot lock', async () => {
    const { a, b, tableId } = await started('xeri'),
      store = app.get(PlatformStore);
    type Balance = { availableMinor: number; reservedMinor: number };
    // Gate the real balance read after it has observed pre-settlement funds.
    // The competing command must wait for that snapshot's table lock rather
    // than mixing the old balance with its subsequently completed room.
    const observed = store as unknown as {
      balance(client: PoolClient, userId: string): Promise<Balance>;
    };
    const original = observed.balance.bind(store);
    let paused = false,
      release!: () => void,
      reached!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      atBalance = new Promise<number>((resolve) => {
        reached = resolve;
      });
    observed.balance = async (client, userId) => {
      const balance = await original(client, userId);
      if (userId === a.id && !paused) {
        paused = true;
        const pid = (
          await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]!.pid;
        reached(pid);
        await gate;
      }
      return balance;
    };
    const reading = store.liveSnapshot(tokenDigest(a.token), 'xeri', tableId);
    let settling: Promise<{ value: unknown } | { error: unknown }> | undefined;
    try {
      const pid = await Promise.race([
        atBalance,
        reading.then(() =>
          assert.fail('Snapshot must reach the gated balance read'),
        ),
      ]);
      settling = store
        .forfeit(tokenDigest(b.token), tableId, randomUUID(), 1)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      let blocked = false;
      const deadline = Date.now() + 5000;
      do {
        blocked = (
          await pool.query<{ blocked: boolean }>(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',
            [pid],
          )
        ).rows[0]!.blocked;
        if (!blocked) await setImmediate();
      } while (!blocked && Date.now() < deadline);
      assert.equal(
        blocked,
        true,
        'Settlement must be blocked by the snapshot transaction',
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
            tableId,
          ])
        ).rowCount,
        0,
      );
      release();
      const before = await reading;
      assert.equal(before.table!.status, 'playing');
      assert.equal(before.game!.status, 'playing');
      assert.equal(before.match!.outcome, null);
      assert.deepEqual(before.balance, {
        availableMinor: 24810,
        reservedMinor: 0,
      });
      const settlement = await settling;
      if ('error' in settlement) throw settlement.error;
      const after = await store.liveSnapshot(
        tokenDigest(a.token),
        'xeri',
        tableId,
      );
      assert.equal(after.table!.status, 'completed');
      assert.equal(after.game!.status, 'completed');
      assert.equal(after.match!.outcome!.ownReturnMinor, 200);
      assert.deepEqual(after.match!.outcome!.winnerUserIds, [a.id]);
      assert.deepEqual(after.balance, {
        availableMinor: 25010,
        reservedMinor: 0,
      });
      await reconciled(tableId);
    } finally {
      release();
      observed.balance = original;
      await reading.catch(() => {});
      await settling;
    }
  });

  void it('checks exact Diloti selections privately without moves, balances or operation writes', async () => {
    const code = 'Preview' + randomUUID().replaceAll('-', '').slice(0, 12);
    const { a, b, players, tableId } = await started('diloti', code);
    const initial = await view(a, tableId),
      actor = mover(players, initial.game.observation),
      other = actor === a ? b : a;
    const current = await view(actor, tableId),
      selection = { card: current.game.observation.hand[0]!, table: [] };
    const request = { expectedRevision: current.game.revision, selection };
    const before = await stored(tableId),
      funds = (await get(actor, 'credits')).json<unknown>();
    const counts = async () =>
      (
        await pool.query<{
          events: number;
          operations: number;
          postings: number;
        }>(
          `SELECT (SELECT count(*)::int FROM match_events) AS events,(SELECT count(*)::int FROM platform_operations) AS operations,(SELECT count(*)::int FROM credit_postings) AS postings`,
        )
      ).rows[0]!;
    const prior = await counts();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(
        actor,
        `tables/${tableId}/selection`,
        request,
      );
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const result = response.json<{
        revision: number;
        preview: { selection: unknown; declarations: unknown[] };
      }>();
      assert.equal(result.revision, current.game.revision);
      assert.deepEqual(result.preview.selection, selection);
      assert.equal(result.preview.declarations.length, 10);
      for (const secret of [
        'initial',
        'seed',
        'hands',
        'stock',
        'history',
        'state',
      ])
        assert.equal(Object.hasOwn(result.preview, secret), false);
      assert.ok(!response.body.includes(before.state.initial.seed));
    }
    assert.deepEqual(await stored(tableId), before);
    assert.deepEqual((await get(actor, 'credits')).json(), funds);
    assert.deepEqual(await counts(), prior);
    assert.equal(
      (await post(other, `tables/${tableId}/selection`, request)).statusCode,
      400,
    );
    const visitor = await player();
    assert.equal(
      (await post(visitor, 'private-access', { code })).statusCode,
      201,
    );
    assert.equal(
      (await post(visitor, `tables/${tableId}/selection`, request)).statusCode,
      403,
    );
    for (const invalid of [
      { ...request, actor: actor.id },
      { ...request, selection: { ...selection, seed: 'forged' } },
      { ...request, selection: { card: 'forged', table: [] } },
    ])
      assert.equal(
        (await post(actor, `tables/${tableId}/selection`, invalid)).statusCode,
        400,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/multiplayer/v1/tables/${tableId}/selection`,
          headers: {
            cookie: actor.cookie,
            origin: 'https://bad.invalid',
            'x-skillbetting-client': 'web-v1',
          },
          payload: request,
        })
      ).statusCode,
      403,
    );
    const action = current.game.observation.legalActions[0]!;
    assert.equal((await move(actor, tableId, current, action)).statusCode, 201);
    assert.equal(
      (await post(actor, `tables/${tableId}/selection`, request)).json<{
        code: string;
      }>().code,
      'stale_game_revision',
    );
    const now = await view(actor, tableId);
    assert.equal(
      (
        await post(actor, `tables/${tableId}/cancel`, {
          operationId: randomUUID(),
        })
      ).json<{ code: string }>().code,
      'cancellation_unavailable',
    );
    assert.equal(
      (
        await post(actor, `tables/${tableId}/forfeit`, {
          operationId: randomUUID(),
          expectedRevision: now.game.revision,
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await post(actor, `tables/${tableId}/selection`, {
          ...request,
          expectedRevision: now.game.revision + 1,
        })
      ).json<{ code: string }>().code,
      'match_ended',
    );
    await reconciled(tableId);
  });

  void it('Koum Kan restores private draws, checks exact selections without writes and treats the first draw as gameplay', async () => {
    const code = 'Koum' + randomUUID().replaceAll('-', '').slice(0, 12);
    const { a, b, players, tableId } = await started('koumkan', code);
    const initial = await view(a, tableId),
      actor = mover(players, initial.game.observation),
      other = actor === a ? b : a;
    const before = await view(actor, tableId),
      op = randomUUID();
    const drawn = await move(
      actor,
      tableId,
      before,
      { type: 'draw', source: 'stock' },
      op,
    );
    assert.equal(drawn.statusCode, 201, drawn.body);
    const current = drawn.json<CommandResponse>();
    assert.equal(current.game.observation.phase, 'meld');
    assert.equal(current.game.observation.hand.length, 11);
    assert.equal(current.match.hasGameplay, true);
    assert.deepEqual(
      (
        await move(
          actor,
          tableId,
          before,
          { type: 'draw', source: 'stock' },
          op,
        )
      ).json(),
      current,
    );
    assert.equal(
      (
        await post(other, `tables/${tableId}/cancel`, {
          operationId: randomUUID(),
        })
      ).json<{ code: string }>().code,
      'cancellation_unavailable',
    );
    const visitor = await player();
    assert.equal(
      (await post(visitor, 'private-access', { code })).statusCode,
      201,
    );
    const selection = { cards: [current.game.observation.hand[0]!] },
      request = { expectedRevision: current.game.revision, selection };
    const saved = await stored(tableId),
      funds = (await get(actor, 'credits')).json<unknown>();
    const counts = async () =>
      (
        await pool.query<{
          events: number;
          operations: number;
          postings: number;
        }>(
          'SELECT (SELECT count(*)::int FROM match_events) AS events,(SELECT count(*)::int FROM platform_operations) AS operations,(SELECT count(*)::int FROM credit_postings) AS postings',
        )
      ).rows[0];
    const prior = await counts();
    for (let i = 0; i < 2; i++) {
      const checked = await post(actor, `tables/${tableId}/selection`, request);
      assert.equal(checked.statusCode, 201, checked.body);
      assert.equal(checked.headers['cache-control'], 'no-store');
      const preview = checked.json<{
        revision: number;
        preview: { selection: unknown; discard: boolean };
      }>();
      assert.equal(preview.revision, current.game.revision);
      assert.deepEqual(preview.preview.selection, selection);
      assert.equal(preview.preview.discard, true);
      assert.equal(checked.body.includes(saved.state.initial.seed), false);
    }
    assert.deepEqual(await stored(tableId), saved);
    assert.deepEqual(await counts(), prior);
    assert.deepEqual((await get(actor, 'credits')).json(), funds);
    assert.equal(
      (await post(other, `tables/${tableId}/selection`, request)).statusCode,
      400,
    );
    assert.equal(
      (await post(visitor, `tables/${tableId}/selection`, request)).statusCode,
      403,
    );
    assert.equal(
      (
        await post(actor, `tables/${tableId}/selection`, {
          ...request,
          selection: {
            cards: [
              saved.state.hands[1 - current.game.observation.viewerSeat]![0]!,
            ],
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(actor, `tables/${tableId}/selection`, {
          ...request,
          selection: { ...selection, winnerId: actor.id },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(actor, `tables/${tableId}/selection`, {
          ...request,
          expectedRevision: 1,
        })
      ).json<{ code: string }>().code,
      'stale_game_revision',
    );
    const restored = await application();
    try {
      assert.deepEqual(
        await view(actor, tableId, restored),
        await view(actor, tableId),
      );
    } finally {
      await restored.close();
    }
    const opponent = await view(other, tableId);
    const observation = opponent.game.observation as unknown as Record<
      string,
      unknown
    >;
    assert.deepEqual(observation.lastPlay, {
      playerId: actor.id,
      action: { type: 'draw', source: 'stock' },
    });
    assert.equal(Object.hasOwn(observation, 'turnDrawn'), false);
    assert.equal(
      (
        await move(actor, tableId, current, {
          type: 'discard',
          card: selection.cards[0],
          winnerId: actor.id,
        })
      ).statusCode,
      400,
    );
    await post(other, `tables/${tableId}/forfeit`, {
      operationId: randomUUID(),
      expectedRevision: current.game.revision,
    });
    assert.equal(
      (await post(actor, `tables/${tableId}/selection`, request)).json<{
        code: string;
      }>().code,
      'match_ended',
    );
    await reconciled(tableId);
  });

  void it('Thanasis protects stock-only play, private restoration, retries and the permanent cancellation cutoff over HTTP and live snapshots', async () => {
    const code = 'Than' + randomUUID().replaceAll('-', '').slice(0, 12);
    const { a, b, players, tableId } = await started('thanasis', code);
    const initial = await view(a, tableId),
      actor = mover(players, initial.game.observation),
      other = actor === a ? b : a;
    const before = await view(actor, tableId),
      original = await stored(tableId);
    const credits = (await get(actor, 'credits')).json<unknown>();
    for (const action of [
      { type: 'draw', source: 'discard' },
      { type: 'draw', source: 'stock', winnerId: actor.id },
    ]) {
      const rejected = await move(actor, tableId, before, action);
      assert.equal(rejected.statusCode, 400, rejected.body);
    }
    assert.deepEqual(await stored(tableId), original);
    assert.deepEqual((await get(actor, 'credits')).json(), credits);
    const operation = randomUUID(),
      drawn = await move(
        actor,
        tableId,
        before,
        { type: 'draw', source: 'stock' },
        operation,
      );
    assert.equal(drawn.statusCode, 201, drawn.body);
    const current = drawn.json<CommandResponse>();
    assert.equal(current.game.observation.hand.length, 11);
    assert.equal(current.match.hasGameplay, true);
    assert.deepEqual(
      (
        await move(
          actor,
          tableId,
          before,
          { type: 'draw', source: 'stock' },
          operation,
        )
      ).json(),
      current,
    );
    assert.equal(
      (
        await post(other, `tables/${tableId}/cancel`, {
          operationId: randomUUID(),
        })
      ).json<{ code: string }>().code,
      'cancellation_unavailable',
    );
    const saved = await stored(tableId);
    for (const action of [
      {
        type: 'meld',
        cards: current.game.observation.hand.slice(0, 3),
        option: 0,
      },
      {
        type: 'close',
        card: saved.state.hands[1 - current.game.observation.viewerSeat]![0],
      },
      {
        type: 'discard',
        card: current.game.observation.hand[0],
        winnerId: actor.id,
      },
    ])
      assert.equal(
        (await move(actor, tableId, current, action)).statusCode,
        400,
      );
    assert.deepEqual(await stored(tableId), saved);
    const visitor = await player();
    assert.equal(
      (await post(visitor, 'private-access', { code })).statusCode,
      201,
    );
    assert.equal(
      (await get(visitor, `tables/${tableId}/game`)).statusCode,
      403,
    );
    const store = app.get(PlatformStore);
    for (const p of [actor, other]) {
      const live = await store.liveSnapshot(
        tokenDigest(p.token),
        'thanasis',
        tableId,
      );
      const observation = live.game!.observation as Record<string, unknown>;
      const seat = p === a ? 0 : 1;
      assert.deepEqual(observation.hand, saved.state.hands[seat]);
      assert.deepEqual(observation.lastPlay, {
        playerId: actor.id,
        action: { type: 'draw', source: 'stock' },
      });
      assert.equal(
        observation.indicator,
        (saved.state as unknown as { indicator: string }).indicator,
      );
      assert.equal(
        JSON.stringify(observation).includes(saved.state.initial.seed),
        false,
      );
      for (const secret of [
        'initial',
        'seed',
        'hands',
        'stock',
        'history',
        'turnDrawn',
      ])
        assert.equal(Object.hasOwn(observation, secret), false);
    }
    const visitorLive = await store.liveSnapshot(
      tokenDigest(visitor.token),
      'thanasis',
      tableId,
    );
    assert.equal(visitorLive.game, undefined);
    const restored = await application();
    try {
      assert.deepEqual(
        await view(actor, tableId, restored),
        await view(actor, tableId),
      );
    } finally {
      await restored.close();
    }
    const forfeited = await post(other, `tables/${tableId}/forfeit`, {
      operationId: randomUUID(),
      expectedRevision: current.game.revision,
    });
    assert.equal(forfeited.statusCode, 201, forfeited.body);
    assert.deepEqual(
      forfeited.json<CommandResponse>().match.outcome!.winnerUserIds,
      [actor.id],
    );
    await reconciled(tableId);
  });

  for (const gameId of ['xeri', 'diloti', 'koumkan', 'thanasis'] as const)
    void it(
      `plays a complete ${gameId} match through round-result controls and settles the immutable roster exactly once`,
      { timeout: 180_000 },
      async () => {
        const { a, b, players, tableId } = await started(gameId);
        let current = await view(a, tableId),
          actions = 0,
          rounds = 0,
          finalOperation = '',
          finalAction: Action = {},
          finalPlayer = a,
          finalBefore = current;
        while (!current.match.outcome && actions < 2500) {
          const observation = current.game.observation,
            active =
              observation.phase === 'round-end'
                ? a
                : mover(players, observation);
          current = await view(active, tableId);
          const action =
            current.game.observation.phase === 'round-end'
              ? { type: 'next' }
              : gameId === 'koumkan'
                ? (current.game.observation.legalActions.find(
                    (a) => a.type === 'draw' && a.source === 'stock',
                  ) ??
                  current.game.observation.legalActions.find(
                    (a) => a.type === 'meld' || a.type === 'extend',
                  ) ??
                  current.game.observation.legalActions.find(
                    (a) => a.type === 'discard',
                  ) ??
                  current.game.observation.legalActions[0]!)
                : gameId === 'diloti'
                  ? (current.game.observation.legalActions.find(
                      (a) => actions % 7 === 0 && a.type === 'declare',
                    ) ??
                    current.game.observation.legalActions.find(
                      (a) => a.type === 'capture',
                    ) ??
                    current.game.observation.legalActions[0]!)
                  : current.game.observation.legalActions[0]!;
          assert.ok(action);
          const operationId = randomUUID(),
            before = current;
          const response = await move(
            active,
            tableId,
            before,
            action,
            operationId,
          );
          assert.equal(response.statusCode, 201, response.body);
          current = response.json<CommandResponse>();
          actions++;
          assert.equal(current.game.revision, before.game.revision + 1);
          assert.equal(current.match.revision, current.game.revision);
          assert.equal(current.match.hasGameplay, true);
          if (action.type === 'next') {
            rounds++;
            assert.equal(
              current.game.observation.ply,
              before.game.observation.ply,
            );
            assert.equal(
              current.game.observation.roundNumber,
              before.game.observation.roundNumber + 1,
            );
            assert.equal(
              current.game.observation.phase,
              gameId === 'koumkan' || gameId === 'thanasis'
                ? 'draw'
                : 'playing',
            );
            const cancel = await post(a, `tables/${tableId}/cancel`, {
              operationId: randomUUID(),
            });
            assert.equal(
              cancel.json<{ code: string }>().code,
              'cancellation_unavailable',
            );
          }
          if (current.match.outcome) {
            finalOperation = operationId;
            finalAction = action;
            finalPlayer = active;
            finalBefore = before;
          }
        }
        assert.ok(current.match.outcome, `No winner after ${actions} actions`);
        if (gameId === 'xeri') assert.ok(rounds > 0);
        if (gameId === 'thanasis')
          assert.ok(current.game.observation.rounds.length >= 5 && rounds >= 4);
        assert.equal(current.game.observation.phase, 'ended');
        assert.equal(current.match.outcome.kind, 'win');
        assert.deepEqual(
          current.match.outcome.winnerUserIds,
          current.game.observation.matchOutcome!.winnerIds ?? [
            current.game.observation.matchOutcome!.winnerId,
          ],
        );
        const repeated = await move(
          finalPlayer,
          tableId,
          finalBefore,
          finalAction,
          finalOperation,
        );
        assert.equal(repeated.statusCode, 201, repeated.body);
        assert.deepEqual(repeated.json(), current);
        const late = await move(finalPlayer, tableId, current, finalAction);
        assert.equal(late.json<{ code: string }>().code, 'match_ended');
        const winner = current.match.outcome.winnerUserIds[0];
        for (const p of [a, b]) {
          const terminal = await view(p, tableId);
          assert.equal(
            terminal.match.outcome!.ownReturnMinor,
            p.id === winner ? 200 : 0,
          );
          const credits = (await get(p, 'credits')).json<{
            balance: { availableMinor: number; reservedMinor: number };
          }>().balance;
          assert.equal(
            credits.availableMinor,
            25000 - 190 + (p.id === winner ? 200 : 0),
          );
          assert.equal(credits.reservedMinor, 0);
        }
        const counts = (
          await pool.query<{ total: number; gameplay: number }>(
            'SELECT count(*)::int AS total,count(*) FILTER (WHERE gameplay)::int AS gameplay FROM match_events WHERE table_id=$1',
            [tableId],
          )
        ).rows[0]!;
        assert.equal(counts.total, current.game.revision);
        assert.equal(counts.gameplay, current.game.observation.ply);
        assert.equal(
          (
            await pool.query('SELECT 1 FROM match_roster WHERE table_id=$1', [
              tableId,
            ])
          ).rowCount,
          2,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT 1 FROM table_participations WHERE table_id=$1',
              [tableId],
            )
          ).rowCount,
          0,
        );
        await reconciled(tableId);
      },
    );
});
