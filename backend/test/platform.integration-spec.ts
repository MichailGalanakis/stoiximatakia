import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { postCredits } from '../src/credits/credit-ledger';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import type {
  CommandResult,
  TableSnapshot,
} from '../src/tables/platform.store';

void describe('funded multiplayer tables against PostgreSQL', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  const schema = 'platform_' + randomUUID().replaceAll('-', '');
  const origin = 'https://test.skillbetting.invalid';
  const logs: unknown[] = [];
  const headers = {
    origin,
    'x-skillbetting-client': 'web-v1',
    'content-type': 'application/json',
  };
  async function application() {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GameRuntimeRegistry)
      .useValue(new GameRuntimeRegistry())
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'isolated-table-secret-'.repeat(3) })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      })
      .compile();
    const instance = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(instance, {
      log: (x) => logs.push(x),
      error: (x) => logs.push(x),
      warn: () => {},
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
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function player(kind: 'registered' | 'demo' = 'registered') {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at)
      VALUES($1,$2,$2,'unused-test-password',$3,$4,$5,$6,$7)`,
      [
        id,
        'U_' + id.replaceAll('-', '').slice(0, 20),
        kind === 'demo' ? id + '@demo.invalid' : id + '@example.com',
        kind === 'demo'
          ? 'demo:' + id
          : '+3069' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
        kind,
        kind === 'demo' ? null : 'test-terms',
        kind === 'demo' ? null : new Date(),
      ],
    );
    await pool.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [tokenDigest(token), id],
    );
    return { id, token, cookie: '__Host-sb_session=' + token };
  }
  type Player = Awaited<ReturnType<typeof player>>;
  const post = (p: Player, path: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/multiplayer/v1/' + path,
      headers: { ...headers, cookie: p.cookie },
      payload: JSON.stringify(payload),
    });
  const get = (p: Player, path: string) =>
    app.inject({
      method: 'GET',
      url: '/multiplayer/v1/' + path,
      headers: { cookie: p.cookie },
    });
  const createInput = (extra: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    gameId: 'chess',
    name: 'Shared chess',
    visibility: 'public',
    formatId: 'standard',
    prizeContributionMinor: 500,
    ...extra,
  });
  async function create(p: Player, extra: Record<string, unknown> = {}) {
    const r = await post(p, 'tables', createInput(extra));
    assert.equal(r.statusCode, 201, r.body);
    return r.json<CommandResult>();
  }
  async function credits(p: Player) {
    return (await get(p, 'credits')).json<{
      balance: { availableMinor: number; reservedMinor: number };
    }>().balance;
  }
  async function drain(p: Player, amount: number) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await postCredits(c, {
        operationKey: 'test-drain:' + randomUUID(),
        kind: 'settle',
        referenceId: 'isolated-test',
        postings: [
          { account: 'available:' + p.id, amount: -amount },
          { account: 'fees', amount },
        ],
      });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }

  async function live(p: Player, target = app) {
    const socket = new WebSocket(
      (await target.getUrl()).replace('http:', 'ws:') + '/multiplayer/v1/live',
      { headers: { origin, cookie: p.cookie } },
    );
    const messages: Record<string, unknown>[] = [];
    socket.on('message', (data) => {
      assert.ok(Buffer.isBuffer(data));
      messages.push(
        JSON.parse(data.toString('utf8')) as Record<string, unknown>,
      );
    });
    await once(socket, 'open');
    async function waitFor(
      predicate: (m: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> {
      const existing = messages.find(predicate);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off('message', check);
          reject(new Error('Websocket event not received'));
        }, 5000);
        const check = () => {
          const match = messages.find(predicate);
          if (match) {
            clearTimeout(timer);
            socket.off('message', check);
            resolve(match);
          }
        };
        socket.on('message', check);
        check();
      });
    }
    return {
      socket,
      messages,
      waitFor,
      send: (value: unknown) => socket.send(JSON.stringify(value)),
      close: async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = once(socket, 'close');
        socket.close();
        await closed;
      },
    };
  }

  void it('grants the same currency to either account kind and keeps session/profile aliases authoritative', async () => {
    for (const kind of ['registered', 'demo'] as const) {
      const p = await player(kind);
      assert.deepEqual(await credits(p), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
      const t = await create(p);
      assert.equal(t.table.seats[0]?.player?.id, p.id);
      assert.equal(t.table.ticket?.state, 'reserved');
      assert.deepEqual(t.balance, {
        availableMinor: 24410,
        reservedMinor: 590,
      });
      const session = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: p.cookie },
      });
      assert.equal(
        session.json<{ account: { demoCreditsMinor: number } }>().account
          .demoCreditsMinor,
        24410,
      );
      const profile = await app.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { cookie: p.cookie },
      });
      assert.equal(
        profile.json<{ account: { demoCreditsMinor: number } }>().account
          .demoCreditsMinor,
        24410,
      );
    }
  });
  void it('makes creation idempotent and rejects reuse with different parameters', async () => {
    const p = await player(),
      input = createInput();
    const first = await post(p, 'tables', input),
      retry = await post(p, 'tables', input);
    assert.equal(first.statusCode, 201);
    assert.deepEqual(retry.json(), first.json());
    assert.equal(
      (await post(p, 'tables', { ...input, name: 'Other' })).json<{
        code: string;
      }>().code,
      'operation_conflict',
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM credit_journals WHERE kind='reserve' AND reference_id=$1",
          [first.json<CommandResult>().table.ticket!.id],
        )
      ).rows[0]?.n,
      1,
    );
  });
  void it('enforces one active table across games under competing create requests', async () => {
    const p = await player();
    const results = await Promise.all([
      post(p, 'tables', createInput()),
      post(p, 'tables', createInput({ gameId: 'tichu', formatId: '1000' })),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM table_participations WHERE user_id=$1',
          [p.id],
        )
      ).rows[0]?.n,
      1,
    );
    assert.equal((await credits(p)).reservedMinor, 590);
  });
  void it('chooses only one winner for the last seat without charging the loser', async () => {
    const owner = await player(),
      a = await player(),
      b = await player(),
      t = await create(owner);
    const results = await Promise.all([
      post(a, `tables/${t.table.id}/seats`, {
        operationId: randomUUID(),
        seatIndex: 1,
      }),
      post(b, `tables/${t.table.id}/seats`, {
        operationId: randomUUID(),
        seatIndex: 1,
      }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    const balances = await Promise.all([credits(a), credits(b)]);
    assert.deepEqual(
      balances.map((v) => v.reservedMinor).sort((a, b) => a - b),
      [0, 590],
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM table_tickets WHERE table_id=$1',
          [t.table.id],
        )
      ).rows[0]?.n,
      2,
    );
    const list = (await get(b, 'tables?gameId=chess')).json<{
      tables: TableSnapshot[];
    }>();
    assert.ok(list.tables.some((v) => v.id === t.table.id));
  });
  void it('grants private details access without reserving a seat or exposing codes/contacts', async () => {
    const owner = await player(),
      visitor = await player(),
      outsider = await player();
    const code = 'Secret123';
    const t = await create(owner, { visibility: 'private', accessCode: code });
    assert.ok(
      !(await get(visitor, 'tables?gameId=chess')).body.includes(t.table.id),
    );
    assert.equal((await get(visitor, 'tables/' + t.table.id)).statusCode, 404);
    assert.equal(
      (await post(visitor, 'private-access', { code: 'secret123' })).statusCode,
      404,
    );
    const access = await post(visitor, 'private-access', { code });
    assert.equal(access.statusCode, 201, access.body);
    assert.deepEqual(await credits(visitor), {
      availableMinor: 25000,
      reservedMinor: 0,
    });
    assert.equal((await get(visitor, 'tables/' + t.table.id)).statusCode, 200);
    assert.equal(
      (
        await post(outsider, `tables/${t.table.id}/seats`, {
          operationId: randomUUID(),
          seatIndex: 1,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await post(visitor, `tables/${t.table.id}/seats`, {
          operationId: randomUUID(),
          seatIndex: 1,
        })
      ).statusCode,
      201,
    );
    for (const secret of [code, '@example.com', 'phone', 'code_hash'])
      assert.ok(!access.body.includes(secret));
    assert.equal(
      (
        await post(
          outsider,
          'tables',
          createInput({ visibility: 'private', accessCode: code }),
        )
      ).json<{ code: string }>().code,
      'private_code_unavailable',
    );
  });
  void it('moves a pre-game seat without another charge and clears readiness', async () => {
    const p = await player(),
      t = await create(p, { gameId: 'tichu', formatId: '1000' });
    assert.equal(
      (
        await post(p, `tables/${t.table.id}/ready`, {
          operationId: randomUUID(),
        })
      ).statusCode,
      201,
    );
    const move = await post(p, `tables/${t.table.id}/seat`, {
      operationId: randomUUID(),
      seatIndex: 2,
    });
    assert.equal(move.statusCode, 201, move.body);
    assert.equal(
      move.json<CommandResult>().table.seats[2]?.player?.ready,
      false,
    );
    assert.deepEqual(await credits(p), {
      availableMinor: 24410,
      reservedMinor: 590,
    });
    assert.equal(
      (await get(p, 'tickets')).json<{ tickets: unknown[] }>().tickets.length,
      1,
    );
  });
  void it('releases the full pre-start cost once and permits another table', async () => {
    const p = await player(),
      t = await create(p, { prizeContributionMinor: 3000 });
    const input = { operationId: randomUUID() };
    const cancelled = await post(p, `tables/${t.table.id}/cancel`, input);
    assert.equal(cancelled.statusCode, 201, cancelled.body);
    assert.equal(
      cancelled.json<CommandResult>().table.ticket?.state,
      'cancelled',
    );
    assert.deepEqual(await credits(p), {
      availableMinor: 25000,
      reservedMinor: 0,
    });
    assert.deepEqual(
      (await post(p, `tables/${t.table.id}/cancel`, input)).json(),
      cancelled.json(),
    );
    assert.equal(
      (
        await post(p, `tables/${t.table.id}/cancel`, {
          operationId: randomUUID(),
        })
      ).statusCode,
      409,
    );
    await create(p, { gameId: 'xeri' });
  });
  void it('closes an empty waiting table once, hiding discovery but retaining tickets and direct reads', async () => {
    const owner = await player(),
      visitor = await player(),
      t = await create(owner);
    const operation = { operationId: randomUUID() };
    const cancelled = await post(
      owner,
      `tables/${t.table.id}/cancel`,
      operation,
    );
    assert.equal(cancelled.statusCode, 201, cancelled.body);
    assert.equal(cancelled.json<CommandResult>().table.status, 'cancelled');
    assert.deepEqual(
      (await post(owner, `tables/${t.table.id}/cancel`, operation)).json(),
      cancelled.json(),
    );
    assert.equal(
      (await get(owner, 'tickets'))
        .json<{ tickets: { tableId: string; state: string }[] }>()
        .tickets.find((v) => v.tableId === t.table.id)?.state,
      'cancelled',
    );
    assert.equal(
      (await get(owner, 'tables/' + t.table.id)).json<CommandResult>().table
        .status,
      'cancelled',
    );
    assert.equal(
      (await get(visitor, 'tables?gameId=chess'))
        .json<{ tables: TableSnapshot[] }>()
        .tables.some((v) => v.id === t.table.id),
      false,
    );
    const client = await live(visitor);
    try {
      client.send({ id: randomUUID(), type: 'subscribe', gameId: 'chess' });
      const snapshot = await client.waitFor((m) => m.type === 'snapshot');
      assert.equal(JSON.stringify(snapshot).includes(t.table.id), false);
    } finally {
      await client.close();
    }
    assert.deepEqual(await credits(owner), {
      availableMinor: 25000,
      reservedMinor: 0,
    });
    assert.equal(
      (
        await pool.query('SELECT 1 FROM table_games WHERE table_id=$1', [
          t.table.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_settlements WHERE table_id=$1', [
          t.table.id,
        ])
      ).rowCount,
      0,
    );
  });
  void it('keeps an occupied waiting table open and closes it when both remaining players cancel concurrently', async () => {
    const a = await player(),
      b = await player(),
      c = await player(),
      t = await create(a);
    assert.equal(
      (
        await post(b, `tables/${t.table.id}/seats`, {
          operationId: randomUUID(),
          seatIndex: 1,
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await post(a, `tables/${t.table.id}/cancel`, {
          operationId: randomUUID(),
        })
      ).json<CommandResult>().table.status,
      'waiting',
    );
    assert.equal(
      (
        await post(c, `tables/${t.table.id}/seats`, {
          operationId: randomUUID(),
          seatIndex: 0,
        })
      ).statusCode,
      201,
    );
    const responses = await Promise.all(
      [b, c].map((p) =>
        post(p, `tables/${t.table.id}/cancel`, { operationId: randomUUID() }),
      ),
    );
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [201, 201],
    );
    const final = (await get(a, 'tables/' + t.table.id)).json<CommandResult>()
      .table;
    assert.equal(final.status, 'cancelled');
    assert.ok(final.seats.every((s) => s.player === null));
    for (const p of [a, b, c])
      assert.deepEqual(await credits(p), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
  });
  void it('serializes last withdrawal against joining without charging a closed table or closing an occupied one', async () => {
    for (const order of [
      'cancel-first',
      'join-first',
      'race',
      'race',
      'race',
    ] as const) {
      const a = await player(),
        b = await player(),
        t = await create(a);
      const cancel = () =>
        post(a, `tables/${t.table.id}/cancel`, { operationId: randomUUID() });
      const join = () =>
        post(b, `tables/${t.table.id}/seats`, {
          operationId: randomUUID(),
          seatIndex: 1,
        });
      let results;
      if (order === 'cancel-first') results = [await cancel(), await join()];
      else if (order === 'join-first') {
        const joined = await join();
        assert.equal(joined.statusCode, 201);
        results = [await cancel(), joined];
      } else results = await Promise.all([cancel(), join()]);
      assert.equal(results[0]!.statusCode, 201);
      const final = (await get(a, 'tables/' + t.table.id)).json<CommandResult>()
        .table;
      if (order === 'cancel-first') assert.equal(final.status, 'cancelled');
      if (order === 'join-first') assert.equal(final.status, 'waiting');
      assert.deepEqual(await credits(a), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
      if (final.status === 'cancelled') {
        assert.ok(final.seats.every((s) => s.player === null));
        assert.deepEqual(await credits(b), {
          availableMinor: 25000,
          reservedMinor: 0,
        });
        if (results[1]) assert.equal(results[1].statusCode, 409);
      } else {
        assert.equal(final.status, 'waiting');
        assert.equal(final.seats[1]?.player?.id, b.id);
        assert.deepEqual(await credits(b), {
          availableMinor: 24410,
          reservedMinor: 590,
        });
      }
    }
  });
  void it('rejects insufficient funds without a partial table, ticket, seat or journal', async () => {
    const p = await player();
    await drain(p, 24900);
    const result = await post(p, 'tables', createInput());
    assert.equal(result.json<{ code: string }>().code, 'insufficient_credits');
    assert.deepEqual(await credits(p), {
      availableMinor: 100,
      reservedMinor: 0,
    });
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM game_tables WHERE creator_id=$1',
          [p.id],
        )
      ).rows[0]?.n,
      0,
    );
    assert.equal(
      (await get(p, 'tickets')).json<{ tickets: unknown[] }>().tickets.length,
      0,
    );
  });
  void it('rejects missing/expired/forged sessions, origins and client-supplied authority fields', async () => {
    const p = await player();
    assert.equal(
      (await app.inject({ method: 'GET', url: '/multiplayer/v1/credits' }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/multiplayer/v1/tables',
          headers: {
            ...headers,
            origin: 'https://evil.invalid',
            cookie: p.cookie,
          },
          payload: createInput(),
        })
      ).statusCode,
      403,
    );
    for (const extra of [
      { feeMinor: 0 },
      { userId: p.id },
      { ready: true },
      { status: 'playing' },
      { gameId: 'invented' },
      { prizeContributionMinor: 0 },
      { visibility: 'private' },
      { accessCode: 'unneeded' },
    ])
      assert.ok(
        (await post(p, 'tables', createInput(extra))).statusCode >= 400,
      );
    await pool.query(
      'UPDATE account_sessions SET expires_at=now() WHERE user_id=$1',
      [p.id],
    );
    assert.equal((await get(p, 'credits')).statusCode, 401);
  });
  void it('keeps a missing engine from starting or capturing funds, then captures only once through an adapter', async () => {
    const a = await player(),
      b = await player(),
      t = await create(a);
    await post(b, `tables/${t.table.id}/seats`, {
      operationId: randomUUID(),
      seatIndex: 1,
    });
    await post(a, `tables/${t.table.id}/ready`, { operationId: randomUUID() });
    const operation = { operationId: randomUUID() };
    assert.equal(
      (await post(b, `tables/${t.table.id}/ready`, operation)).json<{
        code: string;
      }>().code,
      'engine_unavailable',
    );
    assert.equal(
      (await get(a, 'tables/' + t.table.id)).json<{ table: TableSnapshot }>()
        .table.status,
      'waiting',
    );
    assert.equal((await credits(a)).reservedMinor, 590);
    app.get(GameRuntimeRegistry).register('chess', {
      start: (input) => ({
        rulesVersion: 'isolated-test-engine',
        state: { participants: input.participants, turn: 0 },
      }),
    });
    const started = await post(b, `tables/${t.table.id}/ready`, operation);
    assert.equal(started.statusCode, 201, started.body);
    assert.equal(started.json<CommandResult>().table.status, 'playing');
    assert.deepEqual(
      (await post(b, `tables/${t.table.id}/ready`, operation)).json(),
      started.json(),
    );
    assert.deepEqual(await credits(a), {
      availableMinor: 24410,
      reservedMinor: 0,
    });
    assert.deepEqual(await credits(b), {
      availableMinor: 24410,
      reservedMinor: 0,
    });
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT balance_minor::int AS n FROM credit_accounts WHERE key=$1',
          ['pool:' + t.table.id],
        )
      ).rows[0]?.n,
      1000,
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM credit_journals WHERE operation_key=$1',
          ['start:' + t.table.id],
        )
      ).rows[0]?.n,
      1,
    );
    const listed = async () =>
      (await get(a, 'tables?gameId=chess'))
        .json<{ tables: TableSnapshot[] }>()
        .tables.some((table) => table.id === t.table.id);
    assert.equal(await listed(), true);
    const cancelled = await post(a, `tables/${t.table.id}/cancel`, {
      operationId: randomUUID(),
    });
    assert.equal(cancelled.statusCode, 201, cancelled.body);
    assert.equal(cancelled.json<CommandResult>().table.status, 'cancelled');
    assert.equal(await listed(), false);
    const direct = await get(a, `tables/${t.table.id}`);
    assert.equal(direct.statusCode, 200, direct.body);
    assert.equal(direct.json<CommandResult>().table.status, 'cancelled');
  });
  void it('persists participation and funds across application restart with no expiry rule', async () => {
    const p = await player(),
      t = await create(p, { gameId: 'diloti' });
    await app.close();
    app = await application();
    const restored = (await get(p, 'tables/' + t.table.id)).json<{
      table: TableSnapshot;
    }>().table;
    assert.equal(restored.seats[0]?.player?.id, p.id);
    assert.equal(restored.ticket?.id, t.table.ticket?.id);
    assert.deepEqual(await credits(p), {
      availableMinor: 24410,
      reservedMinor: 590,
    });
  });
  void it('enforces balanced append-only journals and reconciliation at the database boundary', async () => {
    const p = await player();
    const before = await credits(p);
    const t = await create(p);
    await assert.rejects(
      pool.query('UPDATE game_tables SET contribution_minor=100 WHERE id=$1', [
        t.table.id,
      ]),
    );
    await assert.rejects(
      pool.query(
        'UPDATE table_tickets SET contribution_minor=100 WHERE id=$1',
        [t.table.ticket!.id],
      ),
    );
    await assert.rejects(
      pool.query('DELETE FROM table_tickets WHERE id=$1', [t.table.ticket!.id]),
    );
    await post(p, `tables/${t.table.id}/cancel`, { operationId: randomUUID() });
    await assert.rejects(
      pool.query(
        "UPDATE credit_accounts SET balance_minor=balance_minor+1 WHERE user_id=$1 AND kind='available'",
        [p.id],
      ),
    );
    await assert.rejects(
      pool.query('UPDATE users SET demo_credits_minor=123 WHERE id=$1', [p.id]),
    );
    await assert.rejects(
      pool.query('DELETE FROM credit_postings WHERE account_key=$1', [
        'available:' + p.id,
      ]),
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO credit_journals(id,operation_key,kind,reference_id) VALUES($1,$2,'settle','isolated-test')",
        [randomUUID(), 'unbalanced:' + randomUUID()],
      );
      await assert.rejects(c.query('COMMIT'));
    } finally {
      c.release();
    }
    assert.deepEqual(await credits(p), before);
    const totals = await pool.query<{ n: string }>(
      'SELECT sum(amount_minor)::text AS n FROM credit_postings',
    );
    assert.equal(totals.rows[0]?.n, '0');
    const mismatches = await pool.query(
      'SELECT a.key FROM credit_accounts a LEFT JOIN credit_postings p ON p.account_key=a.key GROUP BY a.key HAVING a.balance_minor<>coalesce(sum(p.amount_minor),0)',
    );
    assert.equal(mismatches.rowCount, 0);
    assert.ok(!JSON.stringify(logs).includes('Secret123'));
  });
  void it('exchanges authenticated websocket commands and committed lobby/seat updates between accounts', async () => {
    const a = await player(),
      b = await player();
    const first = await live(a),
      second = await live(b);
    try {
      const subscribe = randomUUID();
      second.send({ id: subscribe, type: 'subscribe', gameId: 'chess' });
      await second.waitFor((m) => m.id === subscribe && m.type === 'snapshot');
      const request = randomUUID();
      first.send({ id: request, type: 'create', payload: createInput() });
      const created = await first.waitFor(
        (m) => m.id === request && m.type === 'result',
      );
      const result = created.result as CommandResult;
      const tableId = result.table.id;
      await second.waitFor(
        (m) =>
          m.type === 'snapshot' &&
          Array.isArray(m.tables) &&
          (m.tables as TableSnapshot[]).some((t) => t.id === tableId),
      );
      const joined = randomUUID();
      second.send({
        id: joined,
        type: 'join',
        tableId,
        payload: { operationId: randomUUID(), seatIndex: 1 },
      });
      const accepted = await second.waitFor(
        (m) => m.id === joined && m.type === 'result',
      );
      assert.equal(
        (accepted.result as CommandResult).balance.reservedMinor,
        590,
      );
      const invalid = randomUUID();
      first.send({
        id: invalid,
        type: 'create',
        payload: { ...createInput(), entryFee: 0 },
      });
      assert.equal(
        (await first.waitFor((m) => m.id === invalid)).code,
        'invalid_table_request',
      );
      assert.ok(!JSON.stringify(second.messages).includes(a.token));
    } finally {
      await first.close();
      await second.close();
    }
  });
  void it('restores a websocket snapshot and observes a commit made by a separate application instance', async () => {
    const watcher = await player(),
      owner = await player(),
      connection = await live(watcher);
    const other = await application();
    try {
      const subscribe = randomUUID();
      connection.send({ id: subscribe, type: 'subscribe', gameId: 'xeri' });
      await connection.waitFor((m) => m.id === subscribe);
      const created = await other.inject({
        method: 'POST',
        url: '/multiplayer/v1/tables',
        headers: { ...headers, cookie: owner.cookie },
        payload: createInput({ gameId: 'xeri' }),
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = created.json<CommandResult>().table.id;
      await connection.waitFor(
        (m) =>
          m.type === 'snapshot' &&
          Array.isArray(m.tables) &&
          (m.tables as TableSnapshot[]).some((t) => t.id === id),
      );
      await connection.close();
      const restored = await live(watcher);
      try {
        const request = randomUUID();
        restored.send({
          id: request,
          type: 'subscribe',
          gameId: 'xeri',
          tableId: id,
        });
        // Subscribe may acknowledge with a result while a refresh is running;
        // the authoritative table snapshot can then arrive without that id.
        const snapshot = await restored.waitFor(
          (m) =>
            m.type === 'snapshot' &&
            !!m.table &&
            typeof m.table === 'object' &&
            'id' in m.table &&
            m.table.id === id,
        );
        assert.equal((snapshot.table as TableSnapshot).id, id);
      } finally {
        await restored.close();
      }
    } finally {
      await connection.close();
      await other.close();
    }
  });
  void it('rejects websocket origins/private access and closes a revoked session without releasing its seat', async () => {
    const owner = await player(),
      visitor = await player(),
      t = await create(owner, {
        visibility: 'private',
        accessCode: 'AnotherCode',
      });
    const rejected = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        (
          app.getHttpAdapter().getInstance().server.address() as {
            port: number;
          }
        ).port
          ? `ws://127.0.0.1:${(app.getHttpAdapter().getInstance().server.address() as { port: number }).port}/multiplayer/v1/live`
          : '',
        { headers: { origin: 'https://evil.invalid', cookie: visitor.cookie } },
      );
      socket.on('error', () => {});
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode ?? 0);
      });
      socket.once('open', () => {
        socket.terminate();
        reject(new Error('Untrusted origin accepted'));
      });
    });
    assert.equal(rejected, 403);
    const connection = await live(visitor);
    try {
      const id = randomUUID();
      connection.send({
        id,
        type: 'subscribe',
        gameId: 'chess',
        tableId: t.table.id,
      });
      assert.equal(
        (await connection.waitFor((m) => m.id === id)).code,
        'table_not_found',
      );
      await create(visitor, { gameId: 'koumkan' });
      const closed = once(connection.socket, 'close');
      await pool.query('DELETE FROM account_sessions WHERE user_id=$1', [
        visitor.id,
      ]);
      if (connection.socket.readyState === WebSocket.OPEN)
        connection.send({ id: randomUUID(), type: 'credits' });
      const closeCode: unknown = (await closed)[0];
      assert.equal(closeCode, 1008);
      assert.ok(
        connection.messages.some((m) => m.code === 'account_session_expired'),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM table_participations WHERE user_id=$1',
            [visitor.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT balance_minor::int AS n FROM credit_accounts WHERE user_id=$1 AND kind='reserved'",
            [visitor.id],
          )
        ).rows[0]?.n,
        590,
      );
      assert.deepEqual(await credits(owner), {
        availableMinor: 24410,
        reservedMinor: 590,
      });
    } finally {
      await connection.close();
    }
  });
  void it('preserves every supplied game capacity/format and fixed contribution choice', async () => {
    const games = [
      ['chess', 2, 'standard'],
      ['tichu', 4, 'single'],
      ['tichu', 4, '500'],
      ['tichu', 4, '1000'],
      ['biriba', 4, 'standard'],
      ['thanasis', 2, 'standard'],
      ['koumkan', 2, 'standard'],
      ['diloti', 2, 'standard'],
      ['xeri', 2, 'standard'],
    ] as const;
    for (const [gameId, capacity, formatId] of games) {
      const p = await player();
      const t = await create(p, { gameId, formatId });
      assert.equal(t.table.capacity, capacity);
      assert.equal(t.table.seats.length, capacity);
      assert.equal(t.table.entryFee, 90);
      assert.equal(t.table.formatId, formatId);
      assert.equal(
        (await post(p, 'tables', createInput({ gameId, formatId: 'unknown' })))
          .statusCode,
        400,
      );
    }
    for (const contribution of [100, 500, 1500, 3000]) {
      const p = await player();
      const t = await create(p, { prizeContributionMinor: contribution });
      assert.equal(t.balance.reservedMinor, 90 + contribution);
    }
  });
  void it('resolves a final-ready/cancel race without capturing and releasing the same ticket', async () => {
    app.get(GameRuntimeRegistry).register('xeri', {
      start: () => ({
        rulesVersion: 'isolated-test-race',
        state: { turn: 0 },
      }),
    });
    const a = await player(),
      b = await player(),
      t = await create(a, { gameId: 'xeri' });
    await post(b, `tables/${t.table.id}/seats`, {
      operationId: randomUUID(),
      seatIndex: 1,
    });
    await post(b, `tables/${t.table.id}/ready`, { operationId: randomUUID() });
    const responses = await Promise.all([
      post(a, `tables/${t.table.id}/ready`, { operationId: randomUUID() }),
      post(b, `tables/${t.table.id}/cancel`, { operationId: randomUUID() }),
    ]);
    const state = (await get(a, 'tables/' + t.table.id)).json<{
      table: TableSnapshot;
    }>().table;
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [201, 201],
    );
    assert.deepEqual(await credits(b), {
      availableMinor: 25000,
      reservedMinor: 0,
    });
    if (state.status === 'cancelled') {
      assert.deepEqual(await credits(a), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM match_settlements WHERE table_id=$1',
            [t.table.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            'SELECT balance_minor::int AS n FROM credit_accounts WHERE key=$1',
            ['pool:' + t.table.id],
          )
        ).rows[0]?.n,
        0,
      );
    } else {
      assert.equal(state.status, 'waiting');
      assert.equal((await credits(a)).reservedMinor, 590);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM table_games WHERE table_id=$1', [
            t.table.id,
          ])
        ).rowCount,
        0,
      );
    }
    const journals = await pool.query(
      'SELECT kind FROM credit_journals WHERE operation_key=$1 OR operation_key=$2',
      [
        'start:' + t.table.id,
        'release:' +
          (
            await pool.query<{ id: string }>(
              'SELECT id FROM table_tickets WHERE user_id=$1 AND table_id=$2',
              [b.id, t.table.id],
            )
          ).rows[0]!.id,
      ],
    );
    assert.equal(journals.rowCount, 1);
  });
  void it('rolls back funded creation when the final operation record fails', async () => {
    const p = await player();
    await pool.query(
      `CREATE FUNCTION fail_platform_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated-test-sensitive-failure'; END; $$; CREATE TRIGGER fail_platform_record BEFORE INSERT ON platform_operations FOR EACH ROW EXECUTE FUNCTION fail_platform_record();`,
    );
    try {
      const result = await post(p, 'tables', createInput());
      assert.equal(result.statusCode, 503);
      assert.ok(!result.body.includes('sensitive'));
      assert.deepEqual(await credits(p), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
      assert.equal(
        (await get(p, 'tickets')).json<{ tickets: unknown[] }>().tickets.length,
        0,
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM game_tables WHERE creator_id=$1', [
            p.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM credit_postings p JOIN credit_journals j ON j.id=p.journal_id WHERE p.account_key=$1 AND j.kind='reserve'",
            ['available:' + p.id],
          )
        ).rowCount,
        0,
      );
    } finally {
      await pool.query(
        'DROP TRIGGER fail_platform_record ON platform_operations; DROP FUNCTION fail_platform_record()',
      );
    }
  });
  void it('bounds private-code guessing and rejects fake sessions before writing counters', async () => {
    const actor = await player();
    const before = (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM table_access_limits',
      )
    ).rows[0]!.n;
    const invalid = await app.inject({
      method: 'POST',
      url: '/multiplayer/v1/private-access',
      remoteAddress: '203.0.113.42',
      headers: {
        ...headers,
        cookie: '__Host-sb_session=' + randomBytes(32).toString('hex'),
      },
      payload: { code: 'NoSuchCode' },
    });
    assert.equal(invalid.statusCode, 401);
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM table_access_limits',
        )
      ).rows[0]!.n,
      before,
    );
    for (let i = 0; i < 21; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/multiplayer/v1/private-access',
        remoteAddress: '203.0.113.42',
        headers: { ...headers, cookie: actor.cookie },
        payload: { code: 'NoSuchCode' },
      });
      assert.equal(response.statusCode, i < 20 ? 404 : 429);
    }
  });
});
