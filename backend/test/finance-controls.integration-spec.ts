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
import { WALLET_SETTINGS } from '../src/wallet/wallet-settings';

void describe('finance controls against PostgreSQL', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  const schema = 'finance_' + randomUUID().replaceAll('-', '');
  const origin = 'https://test.skillbetting.invalid';
  const secret = 'sandbox-webhook-secret-'.repeat(2);
  const rootToken = 'wallet-admin-token-'.repeat(2);
  const tokens: Record<string, string> = {};
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

  const call = (
    token: string,
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: '/wallet/v1/admin/' + path,
      headers: {
        authorization: 'Bearer ' + token,
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  async function player() {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at,email_verified)
       VALUES($1,$2,$2,'unused-test-password',$3,$4,'registered','test-terms',now(),true)`,
      [
        id,
        'F_' + id.replaceAll('-', '').slice(0, 20),
        id + '@example.com',
        '+3069' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
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
  function webhook(type: string, depositId: string, amountMinor: number) {
    const body = JSON.stringify({
      id: 'evt_' + randomUUID(),
      type,
      paymentId: depositId,
      providerReference: 'sbx_dep_' + depositId,
      amountMinor,
      currency: 'EUR',
    });
    return app.inject({
      method: 'POST',
      url: '/wallet/v1/providers/sandbox/webhook',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-signature': signSandboxEvent(secret, body),
      },
      payload: body,
    });
  }
  async function funded(amountMinor = 2000) {
    const p = await player();
    const started = await post(p, '/wallet/v1/deposits', {
      operationId: randomUUID(),
      amountMinor,
    });
    assert.equal(started.statusCode, 201, started.body);
    const depositId = started.json<{ deposit: { id: string } }>().deposit.id;
    const r = await webhook('deposit.succeeded', depositId, amountMinor);
    assert.deepEqual(r.json(), { status: 'processed' });
    return { ...p, depositId };
  }
  async function account(key: string) {
    const { rows } = await pool.query<{ amount: number }>(
      'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1',
      [key],
    );
    return rows[0]?.amount ?? 0;
  }
  const withdraw = (p: Player, amountMinor: number) =>
    post(p, '/wallet/v1/withdrawals', {
      operationId: randomUUID(),
      amountMinor,
    });
  const code = (r: { json: <T>() => T }) => r.json<{ code: string }>().code;

  void it('gives named admins their own token and enforces their role', async () => {
    for (const [name, role] of [
      ['finance-a', 'finance'],
      ['finance-b', 'finance'],
      ['viewer-v', 'viewer'],
    ] as const) {
      const r = await call(rootToken, 'POST', 'admins', { name, role });
      assert.equal(r.statusCode, 201, r.body);
      tokens[name] = r.json<{ token: string }>().token;
      assert.match(tokens[name], /^[a-f0-9]{64}$/);
    }
    const duplicate = await call(rootToken, 'POST', 'admins', {
      name: 'finance-a',
      role: 'viewer',
    });
    assert.equal(duplicate.statusCode, 409);
    const listed = await call(rootToken, 'GET', 'admins');
    assert.ok(!listed.body.includes(tokens['finance-a']!));
    assert.ok(!listed.body.includes('token_hash'));

    assert.equal(
      (await call(tokens['viewer-v']!, 'GET', 'summary')).statusCode,
      200,
    );
    const viewerMoves = await call(
      tokens['viewer-v']!,
      'POST',
      'house/capital',
      {
        operationId: randomUUID(),
        direction: 'in',
        amountMinor: 100,
      },
    );
    assert.equal(viewerMoves.statusCode, 403);
    assert.equal(code(viewerMoves), 'admin_forbidden');
    const financeAdmins = await call(tokens['finance-a']!, 'POST', 'admins', {
      name: 'sneaky',
      role: 'admin',
    });
    assert.equal(financeAdmins.statusCode, 403);
    assert.equal(
      (await call('f'.repeat(64), 'GET', 'summary')).statusCode,
      401,
    );

    const temp = await call(rootToken, 'POST', 'admins', {
      name: 'temp-viewer',
      role: 'viewer',
    });
    const tempToken = temp.json<{ token: string }>().token;
    const off = await call(rootToken, 'POST', 'admins/temp-viewer/deactivate');
    assert.equal(off.statusCode, 200, off.body);
    assert.equal((await call(tempToken, 'GET', 'summary')).statusCode, 401);
    await assert.rejects(
      pool.query("UPDATE admin_users SET active=true WHERE name='temp-viewer'"),
    );
  });

  void it('records every admin action with its actor in an append-only log', async () => {
    const r = await call(tokens['finance-a']!, 'POST', 'house/capital', {
      operationId: randomUUID(),
      direction: 'in',
      amountMinor: 1000,
      note: 'Seed reserve',
    });
    assert.equal(r.statusCode, 200, r.body);
    const log = (
      await call(tokens['viewer-v']!, 'GET', 'audit?limit=50')
    ).json<{
      entries: { actor: string; role: string; action: string }[];
    }>().entries;
    assert.ok(
      log.some(
        (e) =>
          e.actor === 'finance-a' &&
          e.role === 'finance' &&
          e.action === 'capital.in',
      ),
    );
    assert.ok(
      log.some((e) => e.actor === 'root' && e.action === 'admin.create'),
    );
    assert.ok(log.some((e) => e.action === 'admin.deactivate'));
    await assert.rejects(pool.query('DELETE FROM admin_audit_log'));
  });

  void it('applies a balance correction only with a second, different admin', async () => {
    const p = await funded(2000);
    const company = await account('external:company');
    const id = randomUUID();
    const input = {
      id,
      userId: p.id,
      amountMinor: 500,
      reason: 'Goodwill credit for a service outage',
    };
    const requested = await call(
      tokens['finance-a']!,
      'POST',
      'corrections',
      input,
    );
    assert.equal(requested.statusCode, 201, requested.body);
    assert.deepEqual(
      (await call(tokens['finance-a']!, 'POST', 'corrections', input)).json(),
      requested.json(),
    );
    assert.equal(await account('available:' + p.id), 2000);
    const self = await call(
      tokens['finance-a']!,
      'POST',
      `corrections/${id}/decision`,
      { decision: 'approve' },
    );
    assert.equal(self.statusCode, 403);
    assert.equal(code(self), 'same_reviewer');
    const approved = await call(
      tokens['finance-b']!,
      'POST',
      `corrections/${id}/decision`,
      { decision: 'approve' },
    );
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(await account('available:' + p.id), 2500);
    assert.equal(await account('external:company'), company - 500);
    const twice = await call(
      tokens['finance-b']!,
      'POST',
      `corrections/${id}/decision`,
      { decision: 'reject' },
    );
    assert.equal(twice.statusCode, 409);

    const debitId = randomUUID();
    await call(tokens['finance-a']!, 'POST', 'corrections', {
      id: debitId,
      userId: p.id,
      amountMinor: -10_000,
      reason: 'Reverse a duplicated credit',
    });
    const tooMuch = await call(
      tokens['finance-b']!,
      'POST',
      `corrections/${debitId}/decision`,
      { decision: 'approve' },
    );
    assert.equal(tooMuch.statusCode, 409);
    assert.equal(code(tooMuch), 'insufficient_funds');
    const rejected = await call(
      tokens['finance-b']!,
      'POST',
      `corrections/${debitId}/decision`,
      { decision: 'reject' },
    );
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(await account('available:' + p.id), 2500);
  });

  void it('freezes withdrawals during a provider dispute and releases them when won', async () => {
    const p = await funded(2000);
    assert.deepEqual(
      (await webhook('deposit.disputed', p.depositId, 2000)).json(),
      { status: 'processed' },
    );
    assert.deepEqual(
      (await webhook('deposit.disputed', p.depositId, 2000)).json(),
      { status: 'ignored', reason: 'dispute_exists' },
    );
    const frozen = await withdraw(p, 1000);
    assert.equal(frozen.statusCode, 403);
    assert.equal(code(frozen), 'account_restricted');
    assert.deepEqual((await webhook('dispute.won', p.depositId, 2000)).json(), {
      status: 'processed',
    });
    assert.equal((await withdraw(p, 1000)).statusCode, 201);
    assert.equal(await account('available:' + p.id), 1000);
  });

  void it('reverses a lost chargeback and records the shortfall the company absorbs', async () => {
    const p = await funded(2000);
    const pending = await withdraw(p, 1500);
    assert.equal(pending.statusCode, 201, pending.body);
    const withdrawalId = pending.json<{ withdrawal: { id: string } }>()
      .withdrawal.id;
    const sandbox = await account('external:sandbox');
    const company = await account('external:company');

    const opened = await call(tokens['finance-a']!, 'POST', 'disputes', {
      depositId: p.depositId,
      reason: 'Cardholder claims the payment was unauthorised',
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const disputeId = opened.json<{ dispute: { id: string } }>().dispute.id;
    const blocked = await call(
      tokens['finance-b']!,
      'POST',
      `withdrawals/${withdrawalId}/approve`,
      {},
    );
    assert.equal(blocked.statusCode, 403);
    assert.equal(code(blocked), 'account_restricted');

    const lost = await call(
      tokens['finance-b']!,
      'POST',
      `disputes/${disputeId}/resolve`,
      { outcome: 'lost', note: 'Provider ruled for the cardholder' },
    );
    assert.equal(lost.statusCode, 200, lost.body);
    const dispute = lost.json<{
      dispute: { recoveredMinor: number; shortfallMinor: number };
    }>().dispute;
    assert.equal(dispute.recoveredMinor, 500);
    assert.equal(dispute.shortfallMinor, 1500);
    assert.equal(await account('available:' + p.id), 0);
    assert.equal(await account('external:sandbox'), sandbox + 2000);
    assert.equal(await account('external:company'), company - 1500);
    const again = await call(
      tokens['finance-b']!,
      'POST',
      `disputes/${disputeId}/resolve`,
      { outcome: 'won' },
    );
    assert.equal(again.statusCode, 409);
    const summary = (await call(tokens['viewer-v']!, 'GET', 'summary')).json<{
      chargebackShortfallMinor: number;
      ledger: { balanced: boolean };
    }>();
    assert.equal(summary.chargebackShortfallMinor, 1500);
    assert.equal(summary.ledger.balanced, true);
  });

  void it('stores reconciliation runs against the provider statement', async () => {
    const summary = (await call(tokens['viewer-v']!, 'GET', 'summary')).json<{
      providers: { provider: string; heldMinor: number }[];
    }>();
    const held = summary.providers.find(
      (x) => x.provider === 'sandbox',
    )!.heldMinor;
    const periodEnd = new Date().toISOString();
    const ok = await call(tokens['finance-a']!, 'POST', 'reconciliations', {
      provider: 'sandbox',
      periodEnd,
      reportedHeldMinor: held,
    });
    assert.equal(ok.statusCode, 201, ok.body);
    const run = ok.json<{
      reconciliation: {
        status: string;
        differenceMinor: number;
        checks: Record<string, boolean>;
      };
    }>().reconciliation;
    assert.equal(run.status, 'ok');
    assert.equal(run.differenceMinor, 0);
    assert.ok(
      Object.values(run.checks).every(Boolean),
      JSON.stringify(run.checks),
    );

    const off = await call(tokens['finance-a']!, 'POST', 'reconciliations', {
      provider: 'sandbox',
      periodEnd,
      reportedHeldMinor: held + 100,
    });
    const mismatch = off.json<{
      reconciliation: { status: string; differenceMinor: number };
    }>().reconciliation;
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(mismatch.differenceMinor, 100);
    const viewerRun = await call(
      tokens['viewer-v']!,
      'POST',
      'reconciliations',
      {
        provider: 'sandbox',
        periodEnd,
        reportedHeldMinor: held,
      },
    );
    assert.equal(viewerRun.statusCode, 403);
    const runs = (
      await call(tokens['viewer-v']!, 'GET', 'reconciliations')
    ).json<{
      reconciliations: { status: string }[];
    }>().reconciliations;
    assert.deepEqual(runs.map((r) => r.status).sort(), ['mismatch', 'ok']);
  });
});
