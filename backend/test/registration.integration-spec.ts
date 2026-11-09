import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { before, after, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import {
  REGISTRATION_SETTINGS,
  TERMS_VERSION,
} from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { verifyPassword } from '../src/registration/password';

void describe('registration against PostgreSQL', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let admin: Pool;
  let databaseUrl: string;
  const schema = `signup_${randomUUID().replaceAll('-', '')}`;
  const logs: unknown[] = [];
  const logger = {
    log: (entry: unknown) => logs.push(entry),
    error: (entry: unknown) => logs.push(entry),
    warn: () => {},
  };
  const headers = {
    origin: 'https://test.skillbetting.invalid',
    'x-skillbetting-client': 'web-v1',
  };
  const payload = (name: string, phone = '+306912345678') => ({
    username: name,
    password: 'test-password-12345',
    email: `${name.toLowerCase()}@example.com`,
    phone,
    termsAccepted: true,
    termsVersion: TERMS_VERSION,
  });
  async function application(url = databaseUrl) {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({
        databaseUrl: url,
        appOrigin: headers.origin,
        secureCookie: true,
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
    const result = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(result, logger);
    await result.init();
    await result.getHttpAdapter().getInstance().ready();
    return result;
  }
  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? '');
    assert.match(
      url.pathname,
      /_test$/,
      'Integration tests require a dedicated *_test database',
    );
    admin = new Pool({ connectionString: url.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.href;
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query(await readFile('migrations/001_registration.sql', 'utf8'));
    await pool.query(
      await readFile('migrations/002_contact_verification.sql', 'utf8'),
    );
    await pool.query(
      await readFile('migrations/003_account_sessions.sql', 'utf8'),
    );
    await pool.query(
      await readFile('migrations/004_profile_details.sql', 'utf8'),
    );
    await pool.query(
      await readFile('migrations/005_registration_dismissal.sql', 'utf8'),
    );
    await pool.query(
      await readFile('migrations/006_credit_ledger.sql', 'utf8'),
    );
    await pool.query(
      await readFile('migrations/007_multiplayer_tables.sql', 'utf8'),
    );
    await pool.query(
      await readFile('migrations/008_match_lifecycle.sql', 'utf8'),
    );
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

  void it('persists a normalized user with email preverified and hashed session, then resumes after app restart', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/registrations',
      headers,
      payload: {
        ...payload('FirstUser'),
        username: ' FirstUser ',
        email: ' FirstUser@EXAMPLE.COM ',
        phone: '6912345678',
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json<{
      registration: {
        id: string;
        status: string;
        email: string;
        phone: string;
        emailVerified: boolean;
        phoneVerified: boolean;
        delivery: { email: string };
      };
    }>();
    assert.equal(body.registration.status, 'verification_required');
    assert.equal(body.registration.emailVerified, true);
    assert.equal(body.registration.phoneVerified, false);
    assert.equal(body.registration.delivery.email, 'verified');
    assert.equal(body.registration.email, 'firstuser@example.com');
    assert.equal(body.registration.phone, '+306912345678');
    assert.equal(response.headers['cache-control'], 'no-store');
    const cookie = String(response.headers['set-cookie']);
    assert.match(cookie, /^__Host-sb_registration=[a-f0-9]{64};/);
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Secure'])
      assert.ok(cookie.includes(flag));
    const user = (
      await pool.query('SELECT * FROM users WHERE id=$1', [
        body.registration.id,
      ])
    ).rows[0] as {
      password_hash: string;
      terms_version: string;
      terms_accepted_at: Date;
      email_verified: boolean;
      phone_verified: boolean;
    };
    assert.equal(
      await verifyPassword(payload('FirstUser').password, user.password_hash),
      true,
    );
    assert.equal(user.terms_version, TERMS_VERSION);
    assert.ok(user.terms_accepted_at instanceof Date);
    assert.equal(user.email_verified, true);
    assert.equal(user.phone_verified, false);
    const token = cookie.split(';')[0]!.split('=')[1]!;
    const session = (
      await pool.query(
        'SELECT token_hash FROM registration_sessions WHERE user_id=$1',
        [body.registration.id],
      )
    ).rows[0] as { token_hash: string };
    assert.equal(session.token_hash, tokenDigest(token));
    assert.ok(!JSON.stringify(body).includes('password'));
    await app.close();
    app = await application();
    const resumed = await app.inject({
      method: 'GET',
      url: '/auth/registration',
      headers: { cookie: cookie.split(';')[0]! },
    });
    assert.deepEqual(resumed.json(), {
      registration: body.registration,
      termsVersion: TERMS_VERSION,
    });
    await pool.query(
      "UPDATE registration_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [body.registration.id],
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/registration',
          headers: { cookie },
        })
      ).json<{ registration: null }>().registration,
      null,
    );
  });

  void it('rejects invalid values, forged privileges, missing acceptance, and stale terms', async () => {
    for (const change of [
      { password: 'short' },
      { username: 'bad name' },
      { email: 'no-email' },
      { phone: '123' },
      { termsAccepted: false },
      { role: 'admin' },
      { emailVerified: true },
      { phone: '+306912345678 ext. 123' },
      { password: 12345 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/registrations',
        headers,
        payload: { ...payload('InvalidUser'), ...change },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(!res.body.includes('test-password'));
    }
    const stale = await app.inject({
      method: 'POST',
      url: '/auth/registrations',
      headers,
      payload: { ...payload('InvalidUser'), termsVersion: 'old' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json<{ code: string }>().code, 'terms_changed');
  });

  void it('rejects cross-origin and simple requests without creating a user', async () => {
    for (const requestHeaders of [
      { origin: 'https://evil.invalid', 'x-skillbetting-client': 'web-v1' },
      { origin: headers.origin },
      { 'x-skillbetting-client': 'web-v1' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/registrations',
        headers: requestHeaders,
        payload: payload('OriginUser'),
      });
      assert.equal(res.statusCode, 403);
    }
    assert.equal(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM users WHERE username='OriginUser'",
        )
      ).rows[0]?.count,
      '0',
    );
  });

  void it('enforces normalized uniqueness atomically under a race', async () => {
    const responses = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: '/auth/registrations',
          headers,
          payload: payload('RacingUser', '+306922345678'),
        }),
      ),
    );
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/auth/registrations',
      headers,
      payload: {
        ...payload('racinguser', '+306932345678'),
        email: 'other@example.com',
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(
      duplicate.json<{ code: string }>().code,
      'registration_conflict',
    );
    for (const change of [
      { email: 'RACINGUSER@example.com' },
      { phone: '+30 692 234 5678' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/registrations',
        headers,
        payload: { ...payload('OtherUser', '+306942345678'), ...change },
      });
      assert.equal(res.statusCode, 409);
    }
    assert.equal(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM users WHERE username_key='racinguser'",
        )
      ).rows[0]?.count,
      '1',
    );
  });

  void it('rolls back the user when session storage fails', async () => {
    await pool.query(`CREATE FUNCTION reject_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private test error'; END $$;
      CREATE TRIGGER reject_session BEFORE INSERT ON registration_sessions FOR EACH ROW EXECUTE FUNCTION reject_session()`);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/registrations',
        headers,
        payload: payload('RollbackUser', '+306952345678'),
      });
      assert.equal(res.statusCode, 503);
      assert.ok(!res.body.includes('private'));
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*) FROM users WHERE username='RollbackUser'",
          )
        ).rows[0]?.count,
        '0',
      );
    } finally {
      await pool.query(
        'DROP TRIGGER reject_session ON registration_sessions; DROP FUNCTION reject_session()',
      );
    }
  });

  void it('limits signup attempts durably and never logs supplied secrets', async () => {
    await pool.query(
      "INSERT INTO registration_limits (key,bucket,attempts) VALUES ($1,date_trunc('hour',now()),10) ON CONFLICT (key,bucket) DO UPDATE SET attempts=10",
      [tokenDigest('127.0.0.1')],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/registrations',
      headers,
      payload: payload('LimitedUser', '+306962345678'),
    });
    assert.equal(res.statusCode, 429);
    const text = JSON.stringify(logs);
    for (const secret of [
      'test-password-12345',
      'firstuser@example.com',
      'private test error',
      'sb_registration=',
    ])
      assert.ok(!text.includes(secret));
  });

  void it('returns a controlled outage error while health stays live', async () => {
    const url = new URL(databaseUrl);
    url.searchParams.set('host', '/tmp/skillbetting-no-database');
    const unavailable = await application(url.href);
    try {
      const res = await unavailable.inject({
        method: 'POST',
        url: '/auth/registrations',
        headers,
        payload: payload('OutageUser'),
      });
      assert.equal(res.statusCode, 503);
      assert.equal(
        res.json<{ code: string }>().code,
        'registration_unavailable',
      );
      assert.ok(!res.body.includes('/tmp'));
      assert.equal(
        (await unavailable.inject({ method: 'GET', url: '/health' }))
          .statusCode,
        200,
      );
    } finally {
      await unavailable.close();
    }
  });

  void it('handles missing and forged sessions without exposing users', async () => {
    for (const cookie of [
      '',
      '__Host-sb_registration=bad',
      '__Host-sb_registration=' + '0'.repeat(64),
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/registration',
        headers: { cookie },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json<{ registration: null }>().registration, null);
    }
  });
});
