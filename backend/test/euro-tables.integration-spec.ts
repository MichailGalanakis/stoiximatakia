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
import type {
  CommandResult,
  TableSnapshot,
} from '../src/tables/platform.store';
import { signSandboxEvent } from '../src/wallet/payment-provider';
import { WALLET_SETTINGS } from '../src/wallet/wallet-settings';

void describe('euro-funded tables against PostgreSQL', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  const schema = 'eurotables_' + randomUUID().replaceAll('-', '');
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
    const registry = new GameRuntimeRegistry();
    registry.register('xeri', {
      version: 'euro-table-test',
      start: () => ({ rulesVersion: 'euro-table-test-rules', state: {} }),
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GameRuntimeRegistry)
      .useValue(registry)
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
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function player(kind: 'verified' | 'unverified' | 'demo' = 'verified') {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    const demo = kind === 'demo';
    await pool.query(
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at,email_verified)
       VALUES($1,$2,$2,'unused-test-password',$3,$4,$5,$6,$7,$8)`,
      [
        id,
        'E_' + id.replaceAll('-', '').slice(0, 20),
        demo ? id + '@demo.invalid' : id + '@example.com',
        demo
          ? 'demo:' + id
          : '+3069' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
        demo ? 'demo' : 'registered',
        demo ? null : 'test-terms',
        demo ? null : new Date(),
        kind === 'verified',
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
  const get = (p: Player, path: string) =>
    app.inject({ method: 'GET', url: path, headers: { cookie: p.cookie } });

  async function funded(amountMinor: number) {
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
  async function euros(p: Player) {
    return (await get(p, '/wallet/v1/balance')).json<{
      availableMinor: number;
      reservedMinor: number;
    }>();
  }
  async function credits(p: Player) {
    const { rows } = await pool.query<{ kind: string; amount: number }>(
      'SELECT kind,balance_minor::float8 AS amount FROM credit_accounts WHERE user_id=$1',
      [p.id],
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.amount]));
  }
  const createInput = (extra: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    gameId: 'xeri',
    name: 'Euro xeri',
    visibility: 'public',
    formatId: 'standard',
    prizeContributionMinor: 500,
    currency: 'EUR',
    ...extra,
  });
  async function createEuro(p: Player) {
    const r = await post(p, '/multiplayer/v1/tables', createInput());
    assert.equal(r.statusCode, 201, r.body);
    return r.json<CommandResult>();
  }
  async function startedTable() {
    const a = await funded(2000);
    const b = await funded(2000);
    const tableId = (await createEuro(a)).table.id;
    const joined = await post(b, `/multiplayer/v1/tables/${tableId}/seats`, {
      operationId: randomUUID(),
      seatIndex: 1,
    });
    assert.equal(joined.statusCode, 201, joined.body);
    for (const p of [a, b]) {
      const r = await post(p, `/multiplayer/v1/tables/${tableId}/ready`, {
        operationId: randomUUID(),
      });
      assert.equal(r.statusCode, 201, r.body);
    }
    return { a, b, tableId };
  }
  async function houseRevenue() {
    const { rows } = await pool.query<{ amount: number }>(
      "SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key='house_revenue'",
    );
    return rows[0]!.amount;
  }

  void it('reserves euros, not credits, and reports the euro balance', async () => {
    const a = await funded(2000);
    const before = await credits(a);
    const created = await createEuro(a);
    assert.equal(created.table.currency, 'EUR');
    assert.equal(created.table.entryFee, 90);
    assert.deepEqual(created.balance, {
      availableMinor: 1410,
      reservedMinor: 590,
    });
    assert.deepEqual(await credits(a), before);
    const tickets = (await get(a, '/multiplayer/v1/tickets')).json<{
      tickets: { currency: string; state: string }[];
    }>();
    assert.deepEqual(
      tickets.tickets.map((t) => [t.currency, t.state]),
      [['EUR', 'reserved']],
    );
  });

  void it('keeps euro tables out of the default credit lobby', async () => {
    const a = await funded(2000);
    const euro = (await createEuro(a)).table.id;
    const viewer = await player();
    const credit = await get(viewer, '/multiplayer/v1/tables?gameId=xeri');
    assert.ok(
      !credit
        .json<{ tables: TableSnapshot[] }>()
        .tables.some((t) => t.id === euro),
    );
    const eur = await get(
      viewer,
      '/multiplayer/v1/tables?gameId=xeri&currency=EUR',
    );
    const listed = eur.json<{ tables: TableSnapshot[] }>().tables;
    assert.ok(listed.some((t) => t.id === euro));
    assert.ok(listed.every((t) => t.currency === 'EUR'));
  });

  void it('admits only funded, verified, registered accounts to euro tables', async () => {
    for (const kind of ['demo', 'unverified'] as const) {
      const r = await post(
        await player(kind),
        '/multiplayer/v1/tables',
        createInput(),
      );
      assert.equal(r.statusCode, 403, r.body);
      assert.equal(r.json<{ code: string }>().code, 'account_not_eligible');
    }
    // Credits cannot pay for a euro seat: 250 demo credits, zero euros.
    const broke = await post(
      await player(),
      '/multiplayer/v1/tables',
      createInput(),
    );
    assert.equal(broke.statusCode, 409);
    assert.equal(broke.json<{ code: string }>().code, 'insufficient_funds');
    // Euros cannot pay for a credit seat either; that table spends credits only.
    const a = await funded(2000);
    const credit = await post(
      a,
      '/multiplayer/v1/tables',
      createInput({ currency: 'credits' }),
    );
    assert.equal(credit.statusCode, 201, credit.body);
    assert.equal(credit.json<CommandResult>().table.currency, 'credits');
    assert.deepEqual(await euros(a), {
      ...(await euros(a)),
      availableMinor: 2000,
      reservedMinor: 0,
    });
    assert.equal((await credits(a)).reserved, 590);
  });

  void it('returns the full euro price when a waiting seat is cancelled', async () => {
    const a = await funded(2000);
    const tableId = (await createEuro(a)).table.id;
    const r = await post(a, `/multiplayer/v1/tables/${tableId}/cancel`, {
      operationId: randomUUID(),
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual(r.json<CommandResult>().balance, {
      availableMinor: 2000,
      reservedMinor: 0,
    });
  });

  void it('commits stakes to a prize pool and pays the winner in euros', async () => {
    const revenue = await houseRevenue();
    const { a, b, tableId } = await startedTable();
    assert.deepEqual(await euros(a), {
      ...(await euros(a)),
      availableMinor: 1410,
      reservedMinor: 0,
    });
    assert.equal(await houseRevenue(), revenue + 180);
    const pool1 = await pool.query<{ amount: number }>(
      'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1',
      ['prize_pool:' + tableId],
    );
    assert.equal(pool1.rows[0]!.amount, 1000);

    const forfeit = await post(a, `/multiplayer/v1/tables/${tableId}/forfeit`, {
      operationId: randomUUID(),
      expectedRevision: 1,
    });
    assert.equal(forfeit.statusCode, 201, forfeit.body);
    assert.equal((await euros(a)).availableMinor, 1410);
    assert.equal((await euros(b)).availableMinor, 2410);
    assert.equal(await houseRevenue(), revenue + 180);
    const settlement = await pool.query<{
      journal_id: string | null;
      wallet_transaction_id: string | null;
    }>(
      'SELECT journal_id,wallet_transaction_id FROM match_settlements WHERE table_id=$1',
      [tableId],
    );
    assert.equal(settlement.rows[0]!.journal_id, null);
    assert.ok(settlement.rows[0]!.wallet_transaction_id);
    const history = (await get(b, '/wallet/v1/transactions')).json<{
      entries: { kind: string; amountMinor: number }[];
    }>();
    assert.deepEqual(
      history.entries.find((e) => e.kind === 'settle'),
      {
        ...history.entries.find((e) => e.kind === 'settle'),
        amountMinor: 1000,
      },
    );
  });

  void it('refunds stake and fee in euros when a started match is cancelled before play', async () => {
    const revenue = await houseRevenue();
    const { a, b, tableId } = await startedTable();
    const r = await post(a, `/multiplayer/v1/tables/${tableId}/cancel`, {
      operationId: randomUUID(),
    });
    assert.equal(r.statusCode, 201, r.body);
    for (const p of [a, b])
      assert.deepEqual(await euros(p), {
        ...(await euros(p)),
        availableMinor: 2000,
        reservedMinor: 0,
      });
    assert.equal(await houseRevenue(), revenue);
  });

  void it('leaves the euro ledger balanced and covered by provider funds', async () => {
    const summary = (
      await app.inject({
        method: 'GET',
        url: '/wallet/v1/admin/summary',
        headers: { authorization: 'Bearer ' + adminToken },
      })
    ).json<{
      playerAvailableMinor: number;
      playerReservedMinor: number;
      pendingWithdrawalMinor: number;
      prizePoolMinor: number;
      houseRevenueMinor: number;
      providers: { provider: string; heldMinor: number }[];
      ledger: { balanced: boolean };
    }>();
    assert.equal(summary.ledger.balanced, true);
    assert.equal(summary.prizePoolMinor, 0);
    assert.equal(
      summary.providers.find((x) => x.provider === 'sandbox')!.heldMinor,
      summary.playerAvailableMinor +
        summary.playerReservedMinor +
        summary.pendingWithdrawalMinor +
        summary.houseRevenueMinor,
    );
  });
});
