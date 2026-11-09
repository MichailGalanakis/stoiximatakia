import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import { TournamentStore } from '../src/tournaments/tournament.store';
import { signSandboxEvent } from '../src/wallet/payment-provider';
import { WalletError } from '../src/wallet/wallet-error';
import { WALLET_SETTINGS } from '../src/wallet/wallet-settings';

interface TournamentView {
  id: string;
  status: string;
  players: number;
  prizePoolMinor: number;
  ticket?: { state: string } | null;
  payouts?: { place: number; payoutMinor: number }[];
}

void describe('euro tournaments against PostgreSQL', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  let store: TournamentStore;
  const schema = 'tournaments_' + randomUUID().replaceAll('-', '');
  const origin = 'https://test.skillbetting.invalid';
  const secret = 'sandbox-webhook-secret-'.repeat(2);
  const adminToken = 'wallet-admin-token-'.repeat(2);
  const headers = {
    origin,
    'x-skillbetting-client': 'web-v1',
    'content-type': 'application/json',
  };

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
      .sort()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(await readFile('migrations/' + file, 'utf8'));
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GameRuntimeRegistry)
      .useValue(new GameRuntimeRegistry())
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'isolated-table-secret-'.repeat(3) })
      .overrideProvider(WALLET_SETTINGS)
      .useValue({
        sandboxSecret: secret,
        adminToken,
        minDepositMinor: 500,
        maxDepositMinor: 100_000,
        minWithdrawalMinor: 1000,
        withdrawalsPerDay: 3,
        withdrawalFloorMinor: 10_000,
        withdrawalShareBps: 8000,
      })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false, rawBody: true },
    );
    configureApplication(app, {
      log: () => {},
      error: () => {},
      warn: () => {},
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    store = app.get(TournamentStore);
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function player(verified = true) {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at,email_verified)
       VALUES($1,$2,$2,'unused-test-password',$3,$4,'registered','test-terms',now(),$5)`,
      [
        id,
        'T_' + id.replaceAll('-', '').slice(0, 20),
        id + '@example.com',
        '+3069' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
        verified,
      ],
    );
    await pool.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [tokenDigest(token), id],
    );
    return { id, cookie: '__Host-sb_session=' + token };
  }
  type Player = Awaited<ReturnType<typeof player>>;
  const post = (p: Player, path: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { ...headers, cookie: p.cookie },
      payload: JSON.stringify(payload),
    });
  const adminCall = (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: '/tournaments/v1/admin/' + path,
      headers: {
        authorization: 'Bearer ' + adminToken,
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  async function funded(amountMinor = 2000) {
    const p = await player();
    const started = await post(p, '/wallet/v1/deposits', {
      operationId: randomUUID(),
      amountMinor,
    });
    assert.equal(started.statusCode, 201, started.body);
    const depositId = started.json<{ deposit: { id: string } }>().deposit.id;
    const body = JSON.stringify({
      id: 'evt_' + randomUUID(),
      type: 'deposit.succeeded',
      paymentId: depositId,
      providerReference: 'sbx_dep_' + depositId,
      amountMinor,
      currency: 'EUR',
    });
    const r = await app.inject({
      method: 'POST',
      url: '/wallet/v1/providers/sandbox/webhook',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-signature': signSandboxEvent(secret, body),
      },
      payload: body,
    });
    assert.deepEqual(r.json(), { status: 'processed' });
    return p;
  }
  async function account(key: string) {
    const { rows } = await pool.query<{ amount: number }>(
      'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1',
      [key],
    );
    return rows[0]?.amount;
  }
  const config = (extra: Record<string, unknown> = {}) => ({
    gameId: 'xeri',
    name: 'Κυριακάτικο τουρνουά ξερής',
    entryFeeMinor: 90,
    contributionMinor: 500,
    minPlayers: 3,
    maxPlayers: 4,
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    cancellationPolicy:
      'Full refund before the start or if the organiser cancels.',
    prizeShares: [6000, 3000, 1000],
    changedBy: 'ops-1',
    ...extra,
  });
  async function create(extra: Record<string, unknown> = {}) {
    const r = await adminCall('POST', 'tournaments', {
      id: randomUUID(),
      ...config(extra),
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json<{ tournament: TournamentView }>().tournament;
  }
  async function buy(p: Player, id: string, operationId = randomUUID()) {
    return post(p, `/tournaments/v1/tournaments/${id}/tickets`, {
      operationId,
    });
  }
  const rejectsWith = (promise: Promise<unknown>, code: string) =>
    assert.rejects(
      promise,
      (e: unknown) => e instanceof WalletError && e.code === code,
    );

  void it('validates configuration, replays creation and records every change', async () => {
    for (const bad of [
      { prizeShares: [6000, 3000] },
      { prizeShares: [2500, 2500, 2500, 2500] },
      { startsAt: new Date(Date.now() - 1000).toISOString() },
      { minPlayers: 5, maxPlayers: 4 },
    ]) {
      const r = await adminCall('POST', 'tournaments', {
        id: randomUUID(),
        ...config(bad),
      });
      assert.equal(r.statusCode, 400, JSON.stringify(bad));
    }
    const id = randomUUID();
    const input = { id, ...config() };
    const first = await adminCall('POST', 'tournaments', input);
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(
      (await adminCall('POST', 'tournaments', input)).json(),
      first.json(),
    );
    const changed = await adminCall('POST', 'tournaments', {
      ...input,
      name: 'Other',
    });
    assert.equal(changed.statusCode, 409);
    const updated = await adminCall('PUT', `tournaments/${id}`, {
      ...config({ maxPlayers: 8, prizeShares: [7000, 3000] }),
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const history = await pool.query(
      'SELECT changed_by FROM tournament_changes WHERE tournament_id=$1',
      [id],
    );
    assert.equal(history.rowCount, 2);
    const denied = await app.inject({
      method: 'POST',
      url: '/tournaments/v1/admin/tournaments',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: randomUUID(), ...config() }),
    });
    assert.equal(denied.statusCode, 401);
  });

  void it('sells one idempotent ticket per player and refunds a cancellation in full', async () => {
    const t = await create();
    const unverified = await buy(await player(false), t.id);
    assert.equal(unverified.statusCode, 403);
    const broke = await buy(await player(), t.id);
    assert.equal(broke.statusCode, 409);
    assert.equal(broke.json<{ code: string }>().code, 'insufficient_funds');

    const p = await funded();
    const operationId = randomUUID();
    const bought = await buy(p, t.id, operationId);
    assert.equal(bought.statusCode, 201, bought.body);
    assert.deepEqual((await buy(p, t.id, operationId)).json(), bought.json());
    assert.equal(await account('available:' + p.id), 1410);
    assert.equal(await account('tournament_pool:' + t.id), 500);
    assert.equal(await account('tournament_fees:' + t.id), 90);
    const again = await buy(p, t.id);
    assert.equal(again.json<{ code: string }>().code, 'already_registered');
    const locked = await adminCall('PUT', `tournaments/${t.id}`, config());
    assert.equal(locked.statusCode, 409);

    const cancelled = await post(
      p,
      `/tournaments/v1/tournaments/${t.id}/tickets/cancel`,
      { operationId: randomUUID() },
    );
    assert.equal(cancelled.statusCode, 201, cancelled.body);
    assert.equal(await account('available:' + p.id), 2000);
    assert.equal(await account('tournament_pool:' + t.id), 0);
    assert.equal(await account('tournament_fees:' + t.id), 0);
    assert.equal((await buy(p, t.id)).statusCode, 201);
  });

  void it('never sells more tickets than seats under concurrent purchases', async () => {
    const t = await create();
    const buyers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => funded()));
    const results = await Promise.all(buyers.map((p) => buy(p, t.id)));
    assert.equal(results.filter((r) => r.statusCode === 201).length, 4);
    assert.ok(
      results
        .filter((r) => r.statusCode !== 201)
        .every((r) => r.json<{ code: string }>().code === 'tournament_full'),
    );
    assert.equal(await account('tournament_pool:' + t.id), 2000);
  });

  void it('starts only when filled, then pays the pool by placing exactly once', async () => {
    const revenue = (await account('house_revenue'))!;
    const t = await create();
    const players = await Promise.all([1, 2, 3, 4].map(() => funded()));
    await buy(players[0]!, t.id);
    await buy(players[1]!, t.id);
    const early = await adminCall('POST', `tournaments/${t.id}/start`);
    assert.equal(early.statusCode, 409);
    assert.equal(early.json<{ code: string }>().code, 'tournament_underfilled');
    await buy(players[2]!, t.id);
    await buy(players[3]!, t.id);
    const started = await adminCall('POST', `tournaments/${t.id}/start`);
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(await account('house_revenue'), revenue + 360);
    assert.equal(await account('tournament_fees:' + t.id), 0);
    assert.equal(
      (await buy(await funded(), t.id)).json<{ code: string }>().code,
      'tournament_unavailable',
    );
    const late = await post(
      players[0]!,
      `/tournaments/v1/tournaments/${t.id}/tickets/cancel`,
      { operationId: randomUUID() },
    );
    assert.equal(late.statusCode, 409);

    const ids = players.map((p) => p.id);
    await rejectsWith(store.complete(t.id, ids.slice(0, 3)), 'invalid_ranking');
    await rejectsWith(
      store.complete(t.id, [ids[0]!, ids[0]!, ids[1]!, ids[2]!]),
      'invalid_ranking',
    );
    await rejectsWith(
      store.complete(t.id, [...ids.slice(0, 3), randomUUID()]),
      'invalid_ranking',
    );
    const ranking = [ids[2]!, ids[0]!, ids[3]!, ids[1]!];
    const done = (await store.complete(t.id, ranking)).tournament;
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.payouts, [
      { place: 1, payoutMinor: 1200 },
      { place: 2, payoutMinor: 600 },
      { place: 3, payoutMinor: 200 },
    ]);
    const balances = await Promise.all(
      players.map((p) => account('available:' + p.id)),
    );
    assert.deepEqual(balances, [2010, 1410, 2610, 1610]);
    assert.equal(await account('tournament_pool:' + t.id), 0);
    await rejectsWith(store.complete(t.id, ranking), 'tournament_unavailable');
  });

  void it('refunds everyone in full when the organiser cancels, before or after the start', async () => {
    const open = await create();
    const a = await funded();
    await buy(a, open.id);
    const cancelledOpen = await adminCall(
      'POST',
      `tournaments/${open.id}/cancel`,
    );
    assert.equal(cancelledOpen.statusCode, 200, cancelledOpen.body);
    assert.equal(await account('available:' + a.id), 2000);

    const revenue = (await account('house_revenue'))!;
    const running = await create();
    const players = await Promise.all([1, 2, 3].map(() => funded()));
    for (const p of players) await buy(p, running.id);
    await adminCall('POST', `tournaments/${running.id}/start`);
    assert.equal(await account('house_revenue'), revenue + 270);
    const cancelled = await adminCall(
      'POST',
      `tournaments/${running.id}/cancel`,
    );
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    for (const p of players)
      assert.equal(await account('available:' + p.id), 2000);
    assert.equal(await account('house_revenue'), revenue);
    const tickets = await pool.query<{ state: string }>(
      'SELECT DISTINCT state FROM tournament_tickets WHERE tournament_id=$1',
      [running.id],
    );
    assert.deepEqual(tickets.rows, [{ state: 'refunded' }]);
  });

  void it('reports a reconciled dashboard and a balanced ledger', async () => {
    const dashboard = (await adminCall('GET', 'tournaments')).json<{
      tournaments: { reconciled: boolean; status: string }[];
    }>();
    assert.ok(dashboard.tournaments.length >= 5);
    assert.ok(dashboard.tournaments.every((t) => t.reconciled));
    const summary = await app.inject({
      method: 'GET',
      url: '/wallet/v1/admin/summary',
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert.equal(
      summary.json<{ ledger: { balanced: boolean } }>().ledger.balanced,
      true,
    );
    const viewer = await player();
    const list = await app.inject({
      method: 'GET',
      url: '/tournaments/v1/tournaments',
      headers: { cookie: viewer.cookie },
    });
    assert.ok(
      list
        .json<{ tournaments: TournamentView[] }>()
        .tournaments.every((t) => ['open', 'running'].includes(t.status)),
    );
    await assert.rejects(
      pool.query(
        "UPDATE tournaments SET contribution_minor=1 WHERE status<>'open'",
      ),
    );
  });
});
