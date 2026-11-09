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
import { postWallet } from '../src/wallet/wallet-ledger';
import { WALLET_SETTINGS } from '../src/wallet/wallet-settings';

void describe('euro wallet against PostgreSQL', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  const schema = 'wallet_' + randomUUID().replaceAll('-', '');
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
        'W_' + id.replaceAll('-', '').slice(0, 20),
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
      url: '/wallet/v1/' + path,
      headers: { ...headers, cookie: p.cookie },
      payload: JSON.stringify(payload),
    });
  const get = (p: Player, path: string) =>
    app.inject({
      method: 'GET',
      url: '/wallet/v1/' + path,
      headers: { cookie: p.cookie },
    });
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
  function webhook(
    event: Record<string, unknown>,
    options: { key?: string; timestamp?: number } = {},
  ) {
    const body = JSON.stringify(event);
    return app.inject({
      method: 'POST',
      url: '/wallet/v1/providers/sandbox/webhook',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-signature': signSandboxEvent(
          options.key ?? secret,
          body,
          options.timestamp,
        ),
      },
      payload: body,
    });
  }
  async function balance(p: Player) {
    const r = await get(p, 'balance');
    assert.equal(r.statusCode, 200, r.body);
    return r.json<{
      availableMinor: number;
      reservedMinor: number;
      pendingWithdrawalMinor: number;
      withdrawableMinor: number;
    }>();
  }
  async function startDeposit(p: Player, amountMinor: number) {
    const r = await post(p, 'deposits', {
      operationId: randomUUID(),
      amountMinor,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json<{
      deposit: { id: string; status: string };
      redirectUrl: string;
    }>();
  }
  const depositEvent = (
    depositId: string,
    amountMinor: number,
    type = 'deposit.succeeded',
  ) => ({
    id: 'evt_' + randomUUID(),
    type,
    paymentId: depositId,
    providerReference: 'sbx_dep_' + depositId,
    amountMinor,
    currency: 'EUR',
  });
  async function funded(amountMinor: number) {
    const p = await player();
    const { deposit } = await startDeposit(p, amountMinor);
    const r = await webhook(depositEvent(deposit.id, amountMinor));
    assert.deepEqual(r.json(), { status: 'processed' });
    return p;
  }
  async function withdraw(p: Player, amountMinor: number) {
    return post(p, 'withdrawals', { operationId: randomUUID(), amountMinor });
  }

  void it('credits a confirmed deposit exactly once and leaves demo credits alone', async () => {
    const p = await player();
    const { deposit, redirectUrl } = await startDeposit(p, 2000);
    assert.equal(deposit.status, 'pending');
    assert.match(redirectUrl, /\/wallet\/sandbox-checkout\?reference=sbx_dep_/);
    assert.equal((await balance(p)).availableMinor, 0);

    const event = depositEvent(deposit.id, 2000);
    assert.deepEqual((await webhook(event)).json(), { status: 'processed' });
    assert.deepEqual((await webhook(event)).json(), { status: 'duplicate' });
    assert.deepEqual(
      (await webhook({ ...event, id: 'evt_' + randomUUID() })).json(),
      { status: 'ignored', reason: 'final' },
    );
    assert.equal((await balance(p)).availableMinor, 2000);

    const credits = await pool.query<{ balance: string }>(
      "SELECT balance_minor AS balance FROM credit_accounts WHERE user_id=$1 AND kind='available'",
      [p.id],
    );
    assert.equal(credits.rows[0]!.balance, '25000');
    const historyResponse = await get(p, 'transactions');
    assert.equal(historyResponse.statusCode, 200, historyResponse.body);
    const history = historyResponse.json<{
      entries: { kind: string; account: string; amountMinor: number }[];
    }>();
    assert.deepEqual(history.entries, [
      {
        ...history.entries[0]!,
        kind: 'deposit',
        account: 'available',
        amountMinor: 2000,
      },
    ]);
  });

  void it('replays a deposit request by operation ID and refuses a changed replay', async () => {
    const p = await player();
    const operationId = randomUUID();
    const first = await post(p, 'deposits', { operationId, amountMinor: 1500 });
    const again = await post(p, 'deposits', { operationId, amountMinor: 1500 });
    assert.equal(first.statusCode, 201);
    assert.deepEqual(again.json(), first.json());
    const changed = await post(p, 'deposits', {
      operationId,
      amountMinor: 1600,
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json<{ code: string }>().code, 'operation_conflict');
    const list = (await get(p, 'deposits')).json<{ deposits: unknown[] }>();
    assert.equal(list.deposits.length, 1);
  });

  void it('rejects forged, stale and mismatched provider events without moving money', async () => {
    const p = await player();
    const { deposit } = await startDeposit(p, 1000);
    const forged = await webhook(depositEvent(deposit.id, 1000), {
      key: 'x'.repeat(46),
    });
    assert.equal(forged.statusCode, 400);
    const stale = await webhook(depositEvent(deposit.id, 1000), {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    assert.equal(stale.statusCode, 400);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/wallet/v1/providers/sandbox/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(depositEvent(deposit.id, 1000)),
    });
    assert.equal(unsigned.statusCode, 400);
    const unknownProvider = await app.inject({
      method: 'POST',
      url: '/wallet/v1/providers/other/webhook',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(unknownProvider.statusCode, 404);
    assert.deepEqual((await webhook(depositEvent(deposit.id, 9999))).json(), {
      status: 'ignored',
      reason: 'amount_mismatch',
    });
    assert.equal((await balance(p)).availableMinor, 0);
    const failed = await webhook(
      depositEvent(deposit.id, 1000, 'deposit.failed'),
    );
    assert.deepEqual(failed.json(), { status: 'processed' });
    const list = (await get(p, 'deposits')).json<{
      deposits: { status: string }[];
    }>();
    assert.equal(list.deposits[0]!.status, 'failed');
    assert.equal((await balance(p)).availableMinor, 0);
  });

  void it('limits real money to verified registered accounts and configured amounts', async () => {
    for (const kind of ['demo', 'unverified'] as const) {
      const r = await post(await player(kind), 'deposits', {
        operationId: randomUUID(),
        amountMinor: 1000,
      });
      assert.equal(r.statusCode, 403);
      assert.equal(r.json<{ code: string }>().code, 'account_not_eligible');
    }
    const p = await player();
    for (const amountMinor of [499, 100_001]) {
      const r = await post(p, 'deposits', {
        operationId: randomUUID(),
        amountMinor,
      });
      assert.equal(r.statusCode, 400);
      assert.equal(r.json<{ code: string }>().code, 'invalid_amount');
    }
    const cross = await app.inject({
      method: 'POST',
      url: '/wallet/v1/deposits',
      headers: { ...headers, origin: 'https://evil.invalid', cookie: p.cookie },
      payload: JSON.stringify({ operationId: randomUUID(), amountMinor: 1000 }),
    });
    assert.equal(cross.statusCode, 403);
  });

  void it('holds, cancels, rejects and pays withdrawals with exact balances', async () => {
    const p = await funded(5000);
    const noDeposit = await withdraw(await player(), 1000);
    assert.equal(noDeposit.statusCode, 403);
    assert.equal((await withdraw(p, 999)).statusCode, 400);
    const tooMuch = await withdraw(p, 5001);
    assert.equal(tooMuch.statusCode, 409);
    assert.equal(tooMuch.json<{ code: string }>().code, 'insufficient_funds');

    const first = await withdraw(p, 2000);
    assert.equal(first.statusCode, 201, first.body);
    const w1 = first.json<{ withdrawal: { id: string; status: string } }>();
    assert.equal(w1.withdrawal.status, 'requested');
    assert.deepEqual(await balance(p), {
      currency: 'EUR',
      availableMinor: 3000,
      reservedMinor: 0,
      pendingWithdrawalMinor: 2000,
      totalMinor: 5000,
      withdrawableMinor: 3000,
    });
    const cancelled = await post(p, `withdrawals/${w1.withdrawal.id}/cancel`, {
      operationId: randomUUID(),
    });
    assert.equal(cancelled.statusCode, 201, cancelled.body);
    assert.equal((await balance(p)).availableMinor, 5000);
    const cancelAgain = await post(
      p,
      `withdrawals/${w1.withdrawal.id}/cancel`,
      {
        operationId: randomUUID(),
      },
    );
    assert.equal(cancelAgain.statusCode, 409);
    const other = await player();
    const foreign = await post(
      other,
      `withdrawals/${w1.withdrawal.id}/cancel`,
      {
        operationId: randomUUID(),
      },
    );
    assert.equal(foreign.statusCode, 404);

    const w2 = (await withdraw(p, 1500)).json<{ withdrawal: { id: string } }>();
    const rejected = await adminCall(
      'POST',
      `withdrawals/${w2.withdrawal.id}/reject`,
      {
        reviewer: 'finance-1',
        note: 'Identity documents missing',
      },
    );
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(
      rejected.json<{ withdrawal: { status: string } }>().withdrawal.status,
      'rejected',
    );
    assert.equal((await balance(p)).availableMinor, 5000);

    const w3 = (await withdraw(p, 3000)).json<{ withdrawal: { id: string } }>();
    const approved = await adminCall(
      'POST',
      `withdrawals/${w3.withdrawal.id}/approve`,
      {
        reviewer: 'finance-1',
      },
    );
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(
      approved.json<{ withdrawal: { status: string } }>().withdrawal.status,
      'processing',
    );
    const reApprove = await adminCall(
      'POST',
      `withdrawals/${w3.withdrawal.id}/approve`,
      {
        reviewer: 'finance-1',
      },
    );
    assert.equal(reApprove.statusCode, 409);
    const payout = {
      id: 'evt_' + randomUUID(),
      type: 'payout.succeeded',
      paymentId: w3.withdrawal.id,
      providerReference: 'sbx_pay_' + w3.withdrawal.id,
      amountMinor: 3000,
      currency: 'EUR',
    };
    assert.deepEqual((await webhook(payout)).json(), { status: 'processed' });
    assert.deepEqual((await webhook(payout)).json(), { status: 'duplicate' });
    assert.deepEqual(await balance(p), {
      currency: 'EUR',
      availableMinor: 2000,
      reservedMinor: 0,
      pendingWithdrawalMinor: 0,
      totalMinor: 2000,
      withdrawableMinor: 2000,
    });
    const list = (await get(p, 'withdrawals')).json<{
      withdrawals: { status: string }[];
    }>();
    assert.deepEqual(
      list.withdrawals.map((w) => w.status),
      ['paid', 'rejected', 'cancelled'],
    );
    // Cancelled requests do not count; rejected and paid do (limit is 3 per 24h).
    assert.equal((await withdraw(p, 1000)).statusCode, 201);
    const limited = await withdraw(p, 1000);
    assert.equal(limited.statusCode, 429);
  });

  void it('caps a withdrawal at €100 or 80% of the available balance', async () => {
    const p = await funded(20_000);
    assert.equal((await balance(p)).withdrawableMinor, 16_000);
    const over = await withdraw(p, 16_001);
    assert.equal(over.statusCode, 409);
    assert.equal(
      over.json<{ code: string }>().code,
      'withdrawal_share_exceeded',
    );
    assert.equal((await withdraw(p, 16_000)).statusCode, 201);
    // The rest is €40, under the €100 floor, so it can follow in full.
    const rest = await balance(p);
    assert.equal(rest.availableMinor, 4000);
    assert.equal(rest.withdrawableMinor, 4000);
    assert.equal((await withdraw(p, 4000)).statusCode, 201);

    const q = await funded(11_000);
    assert.equal((await balance(q)).withdrawableMinor, 10_000);
    assert.equal((await withdraw(q, 10_001)).statusCode, 409);
  });

  void it('returns funds when the provider reports a failed payout', async () => {
    const p = await funded(4000);
    const w = (await withdraw(p, 4000)).json<{ withdrawal: { id: string } }>();
    await adminCall('POST', `withdrawals/${w.withdrawal.id}/approve`, {
      reviewer: 'finance-2',
    });
    const mismatch = await webhook({
      id: 'evt_' + randomUUID(),
      type: 'payout.succeeded',
      paymentId: w.withdrawal.id,
      providerReference: 'sbx_pay_' + w.withdrawal.id,
      amountMinor: 400,
      currency: 'EUR',
    });
    assert.deepEqual(mismatch.json(), {
      status: 'ignored',
      reason: 'amount_mismatch',
    });
    const failed = await webhook({
      id: 'evt_' + randomUUID(),
      type: 'payout.failed',
      paymentId: w.withdrawal.id,
      providerReference: 'sbx_pay_' + w.withdrawal.id,
      amountMinor: 4000,
      currency: 'EUR',
    });
    assert.deepEqual(failed.json(), { status: 'processed' });
    assert.equal((await balance(p)).availableMinor, 4000);
    assert.equal((await balance(p)).pendingWithdrawalMinor, 0);
  });

  void it('admits only one of two concurrent withdrawals that exceed the balance', async () => {
    const p = await funded(3000);
    const results = await Promise.all([withdraw(p, 2000), withdraw(p, 2000)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.deepEqual(await balance(p), {
      currency: 'EUR',
      availableMinor: 1000,
      reservedMinor: 0,
      pendingWithdrawalMinor: 2000,
      totalMinor: 3000,
      withdrawableMinor: 1000,
    });
  });

  void it('supports a stake, settlement and prize cycle without creating or losing a cent', async () => {
    const a = await funded(1000);
    const b = await funded(1000);
    const table = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO wallet_accounts(key,kind) VALUES($1,'prize_pool')",
        ['prize_pool:' + table],
      );
      for (const p of [a, b])
        await postWallet(client, {
          operationKey: `stake:${table}:${p.id}`,
          kind: 'stake_reserve',
          referenceId: table,
          entries: [
            { account: 'available:' + p.id, amount: -190 },
            { account: 'reserved:' + p.id, amount: 190 },
          ],
        });
      await postWallet(client, {
        operationKey: `settle:${table}`,
        kind: 'settle',
        referenceId: table,
        entries: [
          { account: 'reserved:' + a.id, amount: -190 },
          { account: 'reserved:' + b.id, amount: -190 },
          { account: 'house_revenue', amount: 180 },
          { account: 'available:' + a.id, amount: 200 },
        ],
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    assert.equal((await balance(a)).availableMinor, 1010);
    assert.equal((await balance(b)).availableMinor, 810);

    // The database itself refuses an overdraft or an unbalanced transaction.
    const overdraft = await pool.connect();
    try {
      await overdraft.query('BEGIN');
      await assert.rejects(
        postWallet(overdraft, {
          operationKey: 'bad:' + randomUUID(),
          kind: 'stake_reserve',
          referenceId: table,
          entries: [
            { account: 'available:' + b.id, amount: -5000 },
            { account: 'reserved:' + b.id, amount: 5000 },
          ],
        }),
      );
    } finally {
      await overdraft.query('ROLLBACK');
      overdraft.release();
    }
    const unbalanced = await pool.connect();
    try {
      const tx = randomUUID();
      await unbalanced.query('BEGIN');
      await unbalanced.query(
        "INSERT INTO ledger_transactions(id,operation_key,kind,reference_id) VALUES($1,$2,'settle',$3)",
        [tx, 'bad:' + tx, table],
      );
      await unbalanced.query(
        "INSERT INTO ledger_entries(transaction_id,account_key,amount_minor) VALUES($1,'house_revenue',1)",
        [tx],
      );
      await assert.rejects(unbalanced.query('COMMIT'));
    } finally {
      unbalanced.release();
    }
    await assert.rejects(
      pool.query(
        "UPDATE wallet_accounts SET balance_minor=balance_minor+100 WHERE key='house_revenue'",
      ),
    );
    await assert.rejects(pool.query('DELETE FROM ledger_entries'));
  });

  void it('keeps the ledger balanced and reconciled with provider positions', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/wallet/v1/admin/summary',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(denied.statusCode, 401);
    const summary = (await adminCall('GET', 'summary')).json<{
      playerAvailableMinor: number;
      playerReservedMinor: number;
      pendingWithdrawalMinor: number;
      prizePoolMinor: number;
      houseRevenueMinor: number;
      providers: { provider: string; heldMinor: number }[];
      ledger: { balanced: boolean };
    }>();
    assert.equal(summary.ledger.balanced, true);
    const held = summary.providers.find((x) => x.provider === 'sandbox')!;
    assert.equal(
      held.heldMinor,
      summary.playerAvailableMinor +
        summary.playerReservedMinor +
        summary.pendingWithdrawalMinor +
        summary.prizePoolMinor +
        summary.houseRevenueMinor,
    );
    const drift = await pool.query(
      `SELECT a.key FROM wallet_accounts a LEFT JOIN ledger_entries e ON e.account_key=a.key
       GROUP BY a.key,a.balance_minor HAVING a.balance_minor<>coalesce(sum(e.amount_minor),0)`,
    );
    assert.equal(drift.rowCount, 0);
    const open = (await adminCall('GET', 'withdrawals?status=requested')).json<{
      withdrawals: { status: string }[];
    }>();
    assert.ok(open.withdrawals.every((w) => w.status === 'requested'));
  });
});
