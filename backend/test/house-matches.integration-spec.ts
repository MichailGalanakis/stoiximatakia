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
import { signSandboxEvent } from '../src/wallet/payment-provider';
import { WalletError } from '../src/wallet/wallet-error';
import { WALLET_SETTINGS } from '../src/wallet/wallet-settings';
import { WalletStore } from '../src/wallet/wallet.store';

void describe('player-vs-platform matches against PostgreSQL', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  let wallet: WalletStore;
  const schema = 'house_' + randomUUID().replaceAll('-', '');
  const origin = 'https://test.skillbetting.invalid';
  const secret = 'sandbox-webhook-secret-'.repeat(2);
  const adminToken = 'wallet-admin-token-'.repeat(2);
  const offerId = 'stake-5-prize-8';

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
    wallet = app.get(WalletStore);
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
        'H_' + id.replaceAll('-', '').slice(0, 20),
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
  async function funded(amountMinor: number) {
    const p = await player();
    const started = await app.inject({
      method: 'POST',
      url: '/wallet/v1/deposits',
      headers: {
        origin,
        'x-skillbetting-client': 'web-v1',
        'content-type': 'application/json',
        cookie: p.cookie,
      },
      payload: JSON.stringify({ operationId: randomUUID(), amountMinor }),
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
  const adminCall = (method: 'GET' | 'POST', path: string, payload?: unknown) =>
    app.inject({
      method,
      url: '/wallet/v1/admin/' + path,
      headers: {
        authorization: 'Bearer ' + adminToken,
        'content-type': 'application/json',
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  async function capital(direction: 'in' | 'out', amountMinor: number) {
    const r = await adminCall('POST', 'house/capital', {
      operationId: randomUUID(),
      direction,
      amountMinor,
      reviewer: 'finance-1',
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json<{ reserveMinor: number }>().reserveMinor;
  }
  async function account(key: string) {
    const { rows } = await pool.query<{ amount: number }>(
      'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1',
      [key],
    );
    return rows[0]?.amount;
  }
  /** Sets the free reserve to an exact amount using audited capital moves. */
  async function reserveExactly(amountMinor: number) {
    const current = (await account('house_reserve'))!;
    if (current > 0) await capital('out', current);
    if (amountMinor > 0) await capital('in', amountMinor);
  }
  const start = (p: Player) =>
    wallet.startHouseMatch({
      matchId: randomUUID(),
      userId: p.id,
      offerId,
      gameId: 'xeri',
    });
  const rejectsWith = (promise: Promise<unknown>, code: string) =>
    assert.rejects(
      promise,
      (e: unknown) => e instanceof WalletError && e.code === code,
    );

  void it('refuses a match the reserve cannot cover, without moving money', async () => {
    const p = await funded(2000);
    await rejectsWith(start(p), 'house_reserve_insufficient');
    assert.equal(await account('available:' + p.id), 2000);
  });

  void it('records idempotent, audited capital moves and never overdraws the reserve', async () => {
    const operationId = randomUUID();
    const input = {
      operationId,
      direction: 'in',
      amountMinor: 600,
      reviewer: 'finance-1',
      note: 'Initial reserve',
    };
    const first = await adminCall('POST', 'house/capital', input);
    assert.deepEqual(first.json(), { reserveMinor: 600 });
    assert.deepEqual((await adminCall('POST', 'house/capital', input)).json(), {
      reserveMinor: 600,
    });
    const changed = await adminCall('POST', 'house/capital', {
      ...input,
      amountMinor: 700,
    });
    assert.equal(changed.statusCode, 409);
    const over = await adminCall('POST', 'house/capital', {
      ...input,
      operationId: randomUUID(),
      direction: 'out',
      amountMinor: 601,
    });
    assert.equal(over.statusCode, 409);
    assert.equal(
      over.json<{ code: string }>().code,
      'house_reserve_insufficient',
    );
    const audit = await pool.query(
      'SELECT reviewer,note FROM house_capital_movements WHERE id=$1',
      [operationId],
    );
    assert.deepEqual(audit.rows, [
      { reviewer: 'finance-1', note: 'Initial reserve' },
    ]);
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/wallet/v1/admin/house/capital',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...input, operationId: randomUUID() }),
    });
    assert.equal(unauthorized.statusCode, 401);
  });

  void it('pays the full prize on a win: €5 stake plus €3 from the reserve', async () => {
    await reserveExactly(600);
    const p = await funded(2000);
    const match = await start(p);
    assert.equal(match.status, 'active');
    assert.equal(await account('available:' + p.id), 1500);
    assert.equal(await account('house_reserve'), 300);
    assert.equal(await account('house_match:' + match.id), 800);
    await rejectsWith(start(p), 'house_match_active');

    const won = await wallet.settleHouseMatch(match.id, 'won');
    assert.equal(won.status, 'won');
    assert.equal(await account('available:' + p.id), 2300);
    assert.equal(await account('house_reserve'), 300);
    assert.equal(await account('house_match:' + match.id), 0);
    assert.deepEqual(await wallet.settleHouseMatch(match.id, 'won'), won);
    await rejectsWith(
      wallet.settleHouseMatch(match.id, 'lost'),
      'house_match_settled',
    );
  });

  void it('keeps the stake as revenue and frees the reserve on a loss', async () => {
    await reserveExactly(300);
    const revenue = (await account('house_revenue'))!;
    const p = await funded(2000);
    const match = await start(p);
    assert.equal(await account('house_reserve'), 0);
    await wallet.settleHouseMatch(match.id, 'lost');
    assert.equal(await account('available:' + p.id), 1500);
    assert.equal(await account('house_reserve'), 300);
    assert.equal(await account('house_revenue'), revenue + 500);
  });

  void it('returns everything when a match is voided', async () => {
    await reserveExactly(300);
    const p = await funded(2000);
    const match = await start(p);
    await wallet.settleHouseMatch(match.id, 'void');
    assert.equal(await account('available:' + p.id), 2000);
    assert.equal(await account('house_reserve'), 300);
  });

  void it('accepts only as many concurrent matches as the reserve can pay if all win', async () => {
    await reserveExactly(600);
    const players = await Promise.all([1, 2, 3].map(() => funded(2000)));
    const results = await Promise.allSettled(players.map((p) => start(p)));
    const accepted = results.filter((r) => r.status === 'fulfilled');
    assert.equal(accepted.length, 2);
    const refused = results.find((r) => r.status === 'rejected');
    assert.ok(
      refused &&
        refused.reason instanceof WalletError &&
        refused.reason.code === 'house_reserve_insufficient',
    );
    assert.equal(await account('house_reserve'), 0);
    for (const r of accepted) await wallet.settleHouseMatch(r.value.id, 'won');
    const paid = await Promise.all(
      players.map((p) => account('available:' + p.id)),
    );
    assert.deepEqual([...paid].sort(), [2000, 2300, 2300]);
    assert.equal(await account('house_reserve'), 0);
  });

  void it('requires an eligible, funded player and an active offer', async () => {
    await reserveExactly(300);
    await rejectsWith(start(await player(false)), 'account_not_eligible');
    await rejectsWith(start(await player()), 'insufficient_funds');
    await pool.query('UPDATE house_offers SET active=false WHERE id=$1', [
      offerId,
    ]);
    try {
      await rejectsWith(start(await funded(2000)), 'house_offer_unavailable');
    } finally {
      await pool.query('UPDATE house_offers SET active=true WHERE id=$1', [
        offerId,
      ]);
    }
    await assert.rejects(
      pool.query('UPDATE house_offers SET prize_minor=900 WHERE id=$1', [
        offerId,
      ]),
    );
  });

  void it('reports reserve and exposure separately from player funds', async () => {
    await reserveExactly(600);
    const p = await funded(2000);
    const match = await start(p);
    const summary = (await adminCall('GET', 'summary')).json<{
      house: {
        reserveMinor: number;
        exposureMinor: number;
        activeMatches: number;
      };
      ledger: { balanced: boolean };
    }>();
    assert.deepEqual(summary.house, {
      reserveMinor: 300,
      exposureMinor: 800,
      activeMatches: 1,
    });
    assert.equal(summary.ledger.balanced, true);
    const list = (await adminCall('GET', 'house/matches?status=active')).json<{
      matches: { id: string }[];
    }>();
    assert.deepEqual(
      list.matches.map((m) => m.id),
      [match.id],
    );
    await wallet.settleHouseMatch(match.id, 'lost');
    const drift = await pool.query(
      `SELECT a.key FROM wallet_accounts a LEFT JOIN ledger_entries e ON e.account_key=a.key
       GROUP BY a.key,a.balance_minor HAVING a.balance_minor<>coalesce(sum(e.amount_minor),0)`,
    );
    assert.equal(drift.rowCount, 0);
  });
});
