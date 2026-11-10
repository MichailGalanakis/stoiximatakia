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
import {
  rfCode,
  signSandboxEvent,
  validRfCode,
} from '../src/wallet/payment-provider';
import { WALLET_SETTINGS } from '../src/wallet/wallet-settings';
import { WalletStore } from '../src/wallet/wallet.store';

void describe('payment methods, jurisdictions and RF collections', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  let wallet: WalletStore;
  const schema = 'methods_' + randomUUID().replaceAll('-', '');
  const origin = 'https://test.skillbetting.invalid';
  const secret = 'sandbox-webhook-secret-'.repeat(2);
  const rootToken = 'wallet-admin-token-'.repeat(2);
  const iban = 'GR1601101250000000012300695';
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
        adminToken: rootToken,
        minDepositMinor: 500,
        maxDepositMinor: 100_000,
        minWithdrawalMinor: 1000,
        withdrawalsPerDay: 10,
        withdrawalFloorMinor: 10_000,
        withdrawalShareBps: 8000,
        rfIban: iban,
        rfBeneficiary: 'SkillBetting',
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

  async function player(
    options: { phone?: string; emailVerified?: boolean } = {},
  ) {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    const emailVerified = options.emailVerified ?? true;
    await pool.query(
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at,email_verified,phone_verified)
       VALUES($1,$2,$2,'unused-test-password',$3,$4,'registered','test-terms',now(),$5,$6)`,
      [
        id,
        'M_' + id.replaceAll('-', '').slice(0, 20),
        id + '@example.com',
        options.phone ??
          '+3069' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
        emailVerified,
        !emailVerified,
      ],
    );
    await pool.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [tokenDigest(token), id],
    );
    return {
      id,
      cookie: '__Host-sb_session=' + token,
      email: id + '@example.com',
    };
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
  const adminCall = (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: path.startsWith('/') ? path : '/wallet/v1/admin/' + path,
      headers: {
        authorization: 'Bearer ' + rootToken,
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const deposit = (p: Player, amountMinor: number, method?: string) =>
    post(p, '/wallet/v1/deposits', {
      operationId: randomUUID(),
      amountMinor,
      ...(method ? { method } : {}),
    });
  async function cardFunded(p: Player, amountMinor = 2000) {
    const r = await deposit(p, amountMinor);
    assert.equal(r.statusCode, 201, r.body);
    const id = r.json<{ deposit: { id: string } }>().deposit.id;
    const body = JSON.stringify({
      id: 'evt_' + randomUUID(),
      type: 'deposit.succeeded',
      paymentId: id,
      providerReference: 'sbx_dep_' + id,
      amountMinor,
      currency: 'EUR',
    });
    const hook = await app.inject({
      method: 'POST',
      url: '/wallet/v1/providers/sandbox/webhook',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-signature': signSandboxEvent(secret, body),
      },
      payload: body,
    });
    assert.deepEqual(hook.json(), { status: 'processed' });
    return p;
  }
  async function balance(p: Player) {
    return (await get(p, '/wallet/v1/balance')).json<{
      availableMinor: number;
      inTournamentsMinor: number;
      inHouseMatchesMinor: number;
      totalMinor: number;
      monthWinningsMinor: number;
    }>();
  }
  const code = (r: { json: <T>() => T }) => r.json<{ code: string }>().code;

  void it('lists the methods available in the player country', async () => {
    const p = await player();
    const r = await get(p, '/wallet/v1/payment-methods');
    assert.deepEqual(r.json(), {
      country: 'GR',
      methods: [
        { method: 'card', provider: 'sandbox', direction: 'deposit' },
        { method: 'rf_bank', provider: 'bank_rf', direction: 'deposit' },
        {
          method: 'bank_transfer',
          provider: 'bank_rf',
          direction: 'withdrawal',
        },
        { method: 'card', provider: 'sandbox', direction: 'withdrawal' },
      ],
    });
    const unknown = await deposit(p, 1000, 'paypal');
    assert.equal(unknown.statusCode, 409);
    assert.equal(code(unknown), 'payment_method_unavailable');
  });

  void it('blocks real money outside approved jurisdictions until finance sets the country', async () => {
    const us = await player({ phone: '+12025550123' });
    const refused = await deposit(us, 1000);
    assert.equal(refused.statusCode, 403);
    assert.equal(code(refused), 'jurisdiction_unavailable');
    const t = await adminCall('POST', '/tournaments/v1/admin/tournaments', {
      id: randomUUID(),
      gameId: 'xeri',
      name: 'Jurisdiction check',
      entryFeeMinor: 90,
      contributionMinor: 500,
      minPlayers: 2,
      maxPlayers: 4,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      cancellationPolicy: 'Full refund before the start.',
      prizeShares: [10_000],
    });
    assert.equal(t.statusCode, 201, t.body);
    const tid = t.json<{ tournament: { id: string } }>().tournament.id;
    const ticket = await post(
      us,
      `/tournaments/v1/tournaments/${tid}/tickets`,
      {
        operationId: randomUUID(),
      },
    );
    assert.equal(code(ticket), 'jurisdiction_unavailable');

    const set = await adminCall('PUT', `players/${us.id}/jurisdiction`, {
      country: 'GR',
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal((await deposit(us, 1000)).statusCode, 201);
  });

  void it('deactivates a country methods when its approval is withdrawn', async () => {
    const p = await player();
    const off = await adminCall('PUT', 'jurisdictions/GR', {
      approved: false,
      note: 'Licence suspended',
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(code(await deposit(p, 1000)), 'jurisdiction_unavailable');
    const cannot = await adminCall('PUT', 'payment-methods', {
      method: 'card',
      provider: 'sandbox',
      country: 'GR',
      direction: 'deposit',
      active: true,
    });
    assert.equal(cannot.statusCode, 409);

    await adminCall('PUT', 'jurisdictions/GR', {
      approved: true,
      note: 'Sandbox default',
    });
    // Approval alone does not silently reactivate methods.
    assert.equal(code(await deposit(p, 1000)), 'payment_method_unavailable');
    for (const [method, provider, direction] of [
      ['card', 'sandbox', 'deposit'],
      ['card', 'sandbox', 'withdrawal'],
      ['rf_bank', 'bank_rf', 'deposit'],
      ['bank_transfer', 'bank_rf', 'withdrawal'],
    ])
      assert.equal(
        (
          await adminCall('PUT', 'payment-methods', {
            method,
            provider,
            country: 'GR',
            direction,
            active: true,
          })
        ).statusCode,
        200,
      );
    assert.equal((await deposit(p, 1000)).statusCode, 201);
    const log = (await adminCall('GET', 'audit?limit=20')).json<{
      entries: { action: string }[];
    }>().entries;
    assert.ok(log.some((e) => e.action === 'jurisdiction.set'));
    assert.ok(log.some((e) => e.action === 'payment_method.set'));
  });

  void it('credits an RF bank deposit only from a matching statement line, once', async () => {
    const p = await player();
    const r = await deposit(p, 2500, 'rf_bank');
    assert.equal(r.statusCode, 201, r.body);
    const body = r.json<{
      deposit: { id: string; method: string; status: string };
      redirectUrl?: string;
      instructions: { rfCode: string; iban: string };
    }>();
    assert.equal(body.deposit.method, 'rf_bank');
    assert.equal(body.redirectUrl, undefined);
    assert.equal(body.instructions.iban, iban);
    assert.ok(validRfCode(body.instructions.rfCode));
    const other = await deposit(p, 1500, 'rf_bank');
    const otherRf = other.json<{ instructions: { rfCode: string } }>()
      .instructions.rfCode;
    assert.equal((await balance(p)).availableMinor, 0);

    const paidAt = new Date().toISOString();
    const lines = [
      {
        bankReference: 'BANK-1',
        rfCode: body.instructions.rfCode,
        amountMinor: 2500,
        paidAt,
      },
      {
        bankReference: 'BANK-2',
        rfCode: rfCode('ABC123'),
        amountMinor: 1000,
        paidAt,
      },
      { bankReference: 'BANK-3', rfCode: otherRf, amountMinor: 1499, paidAt },
    ];
    const imported = await adminCall('POST', 'bank-receipts', { lines });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.deepEqual(imported.json(), {
      results: [
        { bankReference: 'BANK-1', status: 'matched' },
        {
          bankReference: 'BANK-2',
          status: 'unmatched',
          reason: 'unknown_reference',
        },
        {
          bankReference: 'BANK-3',
          status: 'unmatched',
          reason: 'amount_mismatch',
        },
      ],
    });
    const again = await adminCall('POST', 'bank-receipts', {
      lines: [lines[0], { ...lines[0], bankReference: 'BANK-4' }],
    });
    assert.deepEqual(again.json(), {
      results: [
        { bankReference: 'BANK-1', status: 'duplicate' },
        {
          bankReference: 'BANK-4',
          status: 'unmatched',
          reason: 'deposit_final',
        },
      ],
    });
    assert.equal((await balance(p)).availableMinor, 2500);
    const unmatched = await pool.query(
      "SELECT bank_reference FROM bank_receipts WHERE status='unmatched' ORDER BY 1",
    );
    assert.deepEqual(
      unmatched.rows.map(
        (row: { bank_reference: string }) => row.bank_reference,
      ),
      ['BANK-2', 'BANK-3', 'BANK-4'],
    );

    const w = await post(p, '/wallet/v1/withdrawals', {
      operationId: randomUUID(),
      amountMinor: 2000,
    });
    assert.equal(w.statusCode, 201, w.body);
    const withdrawal = w.json<{
      withdrawal: { id: string; provider: string; method: string };
    }>().withdrawal;
    assert.equal(withdrawal.provider, 'bank_rf');
    assert.equal(withdrawal.method, 'bank_transfer');
    await adminCall('POST', `withdrawals/${withdrawal.id}/approve`, {});
    const paid = await adminCall(
      'POST',
      `withdrawals/${withdrawal.id}/confirm-payout`,
      {
        outcome: 'paid',
        bankReference: 'OUT-1',
      },
    );
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal(
      paid.json<{ withdrawal: { status: string } }>().withdrawal.status,
      'paid',
    );
    const twice = await adminCall(
      'POST',
      `withdrawals/${withdrawal.id}/confirm-payout`,
      {
        outcome: 'paid',
        bankReference: 'OUT-2',
      },
    );
    assert.equal(twice.statusCode, 409);
    assert.equal((await balance(p)).availableMinor, 500);
  });

  void it('shows money in tournaments and house matches, and this month winnings', async () => {
    const p = await cardFunded(await player(), 2000);
    const t = await adminCall('POST', '/tournaments/v1/admin/tournaments', {
      id: randomUUID(),
      gameId: 'diloti',
      name: 'Βραδινό τουρνουά',
      entryFeeMinor: 90,
      contributionMinor: 500,
      minPlayers: 2,
      maxPlayers: 8,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      cancellationPolicy: 'Full refund before the start.',
      prizeShares: [10_000],
    });
    const tid = t.json<{ tournament: { id: string } }>().tournament.id;
    const bought = await post(p, `/tournaments/v1/tournaments/${tid}/tickets`, {
      operationId: randomUUID(),
    });
    assert.equal(bought.statusCode, 201, bought.body);
    await adminCall('POST', 'house/capital', {
      operationId: randomUUID(),
      direction: 'in',
      amountMinor: 1000,
    });
    const match = await wallet.startHouseMatch({
      matchId: randomUUID(),
      userId: p.id,
      offerId: 'stake-5-prize-8',
      gameId: 'xeri',
    });
    let b = await balance(p);
    assert.equal(b.availableMinor, 2000 - 590 - 500);
    assert.equal(b.inTournamentsMinor, 590);
    assert.equal(b.inHouseMatchesMinor, 500);
    assert.equal(b.totalMinor, 2000);
    assert.equal(b.monthWinningsMinor, 0);
    await wallet.settleHouseMatch(match.id, 'won');
    b = await balance(p);
    assert.equal(b.inHouseMatchesMinor, 0);
    assert.equal(b.monthWinningsMinor, 800);
  });

  void it('confirms ticket purchases by email to verified addresses only', async () => {
    await pool.query(
      "UPDATE notification_outbox SET status='skipped' WHERE status='pending'",
    );
    const t = await adminCall('POST', '/tournaments/v1/admin/tournaments', {
      id: randomUUID(),
      gameId: 'xeri',
      name: 'Τουρνουά επιβεβαίωσης',
      entryFeeMinor: 90,
      contributionMinor: 500,
      minPlayers: 2,
      maxPlayers: 8,
      startsAt: new Date(Date.now() + 7_200_000).toISOString(),
      cancellationPolicy: 'Full refund before the start.',
      prizeShares: [10_000],
    });
    const tid = t.json<{ tournament: { id: string } }>().tournament.id;
    const verified = await cardFunded(await player());
    const phoneOnly = await cardFunded(await player({ emailVerified: false }));
    for (const p of [verified, phoneOnly])
      assert.equal(
        (
          await post(p, `/tournaments/v1/tournaments/${tid}/tickets`, {
            operationId: randomUUID(),
          })
        ).statusCode,
        201,
      );
    const sent: { to: string; subject: string; text: string }[] = [];
    const counts = await wallet.dispatchNotifications(async (m) => {
      sent.push(m);
      await Promise.resolve();
    });
    assert.deepEqual(counts, { sent: 1, skipped: 1, failed: 0 });
    assert.equal(sent[0]!.to, verified.email);
    assert.match(sent[0]!.subject, /Τουρνουά επιβεβαίωσης/);
    assert.match(sent[0]!.text, /Κωδικός εισιτηρίου/);
    assert.deepEqual(
      await wallet.dispatchNotifications(() => Promise.resolve()),
      { sent: 0, skipped: 0, failed: 0 },
    );

    const another = await cardFunded(await player());
    await post(another, `/tournaments/v1/tournaments/${tid}/tickets`, {
      operationId: randomUUID(),
    });
    for (let i = 0; i < 5; i++)
      await wallet.dispatchNotifications(() =>
        Promise.reject(new Error('down')),
      );
    const failed = await pool.query<{ status: string; attempts: number }>(
      'SELECT status,attempts FROM notification_outbox WHERE user_id=$1',
      [another.id],
    );
    assert.deepEqual(failed.rows, [{ status: 'failed', attempts: 5 }]);
  });

  void it('runs unattended reconciliation once per day per provider', async () => {
    const first = await wallet.runScheduledReconciliation();
    assert.deepEqual(
      first.runs.map((r) => [r.provider, r.status, r.reportedHeldMinor]),
      [
        ['bank_rf', 'ok', null],
        ['sandbox', 'ok', null],
      ],
    );
    assert.deepEqual((await wallet.runScheduledReconciliation()).runs, []);
    const log = (await adminCall('GET', 'audit?limit=10')).json<{
      entries: { actor: string; action: string }[];
    }>().entries;
    assert.ok(
      log.some(
        (e) => e.actor === 'system' && e.action === 'reconciliation.run',
      ),
    );
  });
});
