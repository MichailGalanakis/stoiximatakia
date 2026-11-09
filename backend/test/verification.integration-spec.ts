import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, beforeEach, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import {
  REGISTRATION_SETTINGS,
  TERMS_VERSION,
} from '../src/registration/registration-settings';
import {
  VERIFICATION_CONFIG,
  VERIFICATION_DELIVERY,
  type VerificationDelivery,
} from '../src/registration/verification-delivery';

class FakeDelivery implements VerificationDelivery {
  calls: Parameters<VerificationDelivery['send']>[0][] = [];
  failPhone = false;
  available(): boolean {
    return true;
  }
  async send(
    input: Parameters<VerificationDelivery['send']>[0],
  ): Promise<void> {
    this.calls.push(input);
    if (input.channel === 'phone' && this.failPhone)
      throw new Error('private provider body and secret');
    await Promise.resolve();
  }
}
interface View {
  id: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  delivery: Record<'email' | 'phone', string>;
  verification: Record<'email' | 'phone', { retryAfterSeconds: number }>;
}
void describe('verification codes against PostgreSQL', () => {
  let app: NestFastifyApplication, pool: Pool, admin: Pool, url: string;
  const schema = 'codes_' + randomUUID().replaceAll('-', '');
  const delivery = new FakeDelivery();
  const logs: unknown[] = [];
  const headers = {
    origin: 'https://test.skillbetting.invalid',
    'x-skillbetting-client': 'web-v1',
  };
  let counter = 0;
  async function application() {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({
        databaseUrl: url,
        appOrigin: headers.origin,
        secureCookie: true,
      })
      .overrideProvider(VERIFICATION_DELIVERY)
      .useValue(delivery)
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({ secret: 'test-only-secret-'.repeat(5) })
      .compile();
    const instance = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(instance, {
      log: (value: unknown) => logs.push(value),
      error: (value: unknown) => logs.push(value),
      warn: () => {},
    });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
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
    for (const file of [
      '001_registration.sql',
      '002_contact_verification.sql',
      '003_account_sessions.sql',
      '004_profile_details.sql',
      '005_registration_dismissal.sql',
      '006_credit_ledger.sql',
      '007_multiplayer_tables.sql',
      '008_match_lifecycle.sql',
    ])
      await pool.query(await readFile(`migrations/${file}`, 'utf8'));
    app = await application();
  });
  beforeEach(async () => {
    delivery.calls = [];
    delivery.failPhone = false;
    await pool.query('DELETE FROM registration_limits');
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function signup(unverifiedEmail = true) {
    counter++;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/registrations',
      headers,
      payload: {
        username: `CodePlayer${counter}`,
        password: 'test-passphrase-123',
        email: `codes${counter}@example.com`,
        phone: `+30691${String(counter).padStart(7, '0')}`,
        termsAccepted: true,
        termsVersion: TERMS_VERSION,
      },
    });
    assert.equal(response.statusCode, 201);
    const user = response.json<{ registration: View }>().registration;
    // Keep exercising email OTPs for existing accounts during the signup bypass.
    if (unverifiedEmail)
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        user.id,
      ]);
    return {
      cookie: String(response.headers['set-cookie']).split(';')[0]!,
      user,
    };
  }
  const post = (
    cookie: string,
    path: string,
    payload: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/auth/registration/codes' + path,
      headers: { ...headers, cookie },
      payload,
    });
  const code = (channel: 'email' | 'phone') =>
    delivery.calls.findLast((call) => call.channel === channel)!.code;

  void it('preverifies signup email, skips email delivery and still requires a valid SMS code', async () => {
    const { cookie, user } = await signup(false);
    assert.equal(user.emailVerified, true);
    assert.equal(user.phoneVerified, false);
    const responses = await Promise.all([post(cookie, ''), post(cookie, '')]);
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
      const view = response.json<{ registration: View }>().registration;
      assert.equal(view.delivery.email, 'verified');
      assert.equal(view.phoneVerified, false);
    }
    assert.deepEqual(
      delivery.calls.map((call) => call.channel),
      ['phone'],
    );
    assert.equal((await post(cookie, '/email/send')).statusCode, 200);
    assert.equal(delivery.calls.length, 1);
    const correct = code('phone');
    const wrong = correct === '000000' ? '000001' : '000000';
    assert.equal(
      (await post(cookie, '/phone/verify', { code: wrong })).statusCode,
      400,
    );
    const verified = await post(cookie, '/phone/verify', { code: correct });
    assert.equal(verified.statusCode, 200);
    assert.equal(
      verified.json<{ registration: View }>().registration.phoneVerified,
      true,
    );
    const challenges = await pool.query<{ channel: string }>(
      'SELECT channel FROM verification_challenges WHERE user_id=$1',
      [user.id],
    );
    assert.deepEqual(challenges.rows, [{ channel: 'phone' }]);
  });

  void it('sends both once on first entry; reloads and concurrent entries cannot send again', async () => {
    const { cookie, user } = await signup();
    assert.equal(delivery.calls.length, 0);
    const responses = await Promise.all([post(cookie, ''), post(cookie, '')]);
    for (const response of responses) assert.equal(response.statusCode, 200);
    assert.equal(delivery.calls.length, 2);
    const view = responses[0].json<{ registration: View }>().registration;
    assert.equal(view.delivery.email, 'sent');
    assert.equal(view.delivery.phone, 'sent');
    assert.ok(
      view.verification.email.retryAfterSeconds > 0 &&
        view.verification.email.retryAfterSeconds <= 60,
    );
    for (const call of delivery.calls) assert.match(call.code, /^[0-9]{6}$/);
    const stored = await pool.query<{ code_digest: string }>(
      'SELECT code_digest FROM verification_challenges WHERE user_id=$1',
      [user.id],
    );
    assert.equal(stored.rowCount, 2);
    assert.ok(stored.rows.every((r) => /^[a-f0-9]{64}$/.test(r.code_digest)));
    await app.close();
    app = await application();
    const resumed = await app.inject({
      method: 'GET',
      url: '/auth/registration',
      headers: { cookie },
    });
    assert.equal(
      resumed.json<{ registration: View }>().registration.delivery.email,
      'sent',
    );
    await post(cookie, '');
    assert.equal(delivery.calls.length, 2);
  });
  void it('enforces independent 60-second cooldowns server-side even across races', async () => {
    const { cookie, user } = await signup();
    await post(cookie, '');
    const denied = await post(cookie, '/email/send');
    assert.equal(denied.statusCode, 429);
    assert.ok(Number(denied.headers['retry-after']) > 0);
    await pool.query(
      "UPDATE verification_challenges SET resend_at=now()-interval '1 second' WHERE user_id=$1 AND channel='email'",
      [user.id],
    );
    const results = await Promise.all([
      post(cookie, '/email/send'),
      post(cookie, '/email/send'),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 429]);
    assert.equal(delivery.calls.filter((c) => c.channel === 'email').length, 2);
    assert.equal((await post(cookie, '/phone/send')).statusCode, 429);
  });
  void it('resend replaces the old code and verification consumes the latest code without granting access', async () => {
    const { cookie, user } = await signup();
    await post(cookie, '');
    const old = code('email');
    await pool.query(
      "UPDATE verification_challenges SET resend_at=now()-interval '1 second' WHERE user_id=$1",
      [user.id],
    );
    await post(cookie, '/email/send');
    const current = code('email');
    if (old !== current)
      assert.equal(
        (await post(cookie, '/email/verify', { code: old })).statusCode,
        400,
      );
    const email = await post(cookie, '/email/verify', { code: current });
    assert.equal(email.statusCode, 200);
    assert.equal(
      email.json<{ registration: View }>().registration.emailVerified,
      true,
    );
    assert.equal(
      email.json<{ registration: View }>().registration.phoneVerified,
      false,
    );
    const phone = await post(cookie, '/phone/verify', { code: code('phone') });
    assert.equal(phone.statusCode, 200);
    assert.equal(
      phone.json<{ registration: View }>().registration.phoneVerified,
      true,
    );
    assert.equal(
      (
        await pool.query<{ status: string }>(
          'SELECT status FROM users WHERE id=$1',
          [user.id],
        )
      ).rows[0]?.status,
      'verification_required',
    );
    assert.equal(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*) FROM verification_challenges WHERE user_id=$1 AND code_digest IS NOT NULL',
          [user.id],
        )
      ).rows[0]?.count,
      '0',
    );
    const count = delivery.calls.length;
    await post(cookie, '/email/send');
    assert.equal(delivery.calls.length, count);
  });
  void it('rejects expired codes and commits failed attempts so five guesses lock a challenge', async () => {
    const { cookie, user } = await signup();
    await post(cookie, '');
    const correct = code('email'),
      wrong = correct === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await post(cookie, '/email/verify', { code: wrong })).statusCode,
        400,
      );
    assert.equal(
      (await post(cookie, '/email/verify', { code: correct })).statusCode,
      400,
    );
    assert.equal(
      (
        await pool.query<{ attempts: number }>(
          "SELECT attempts FROM verification_challenges WHERE user_id=$1 AND channel='email'",
          [user.id],
        )
      ).rows[0]?.attempts,
      5,
    );
    await pool.query(
      "UPDATE verification_challenges SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND channel='phone'",
      [user.id],
    );
    assert.equal(
      (await post(cookie, '/phone/verify', { code: code('phone') })).statusCode,
      400,
    );
  });
  void it('keeps failed SMS separate from successful email and preserves the cooldown', async () => {
    const { cookie, user } = await signup();
    delivery.failPhone = true;
    const result = await post(cookie, '');
    assert.equal(result.statusCode, 200);
    const view = result.json<{ registration: View }>().registration;
    assert.equal(view.delivery.email, 'sent');
    assert.equal(view.delivery.phone, 'failed');
    assert.ok(view.verification.phone.retryAfterSeconds > 0);
    assert.equal(
      (
        await pool.query<{ code_digest: null }>(
          "SELECT code_digest FROM verification_challenges WHERE user_id=$1 AND channel='phone'",
          [user.id],
        )
      ).rows[0]?.code_digest,
      null,
    );
    assert.equal((await post(cookie, '/phone/send')).statusCode, 429);
    await pool.query(
      "UPDATE verification_challenges SET resend_at=now()-interval '1 second' WHERE user_id=$1 AND channel='phone'",
      [user.id],
    );
    assert.equal((await post(cookie, '/phone/send')).statusCode, 503);
    assert.ok(!JSON.stringify(logs).includes('private provider body'));
  });
  void it('limits sends per hour and rejects expired sessions, untrusted origins, and forged destinations', async () => {
    const { cookie, user } = await signup();
    await post(cookie, '');
    await pool.query(
      "UPDATE verification_challenges SET send_count=10,resend_at=now()-interval '1 second' WHERE user_id=$1 AND channel='email'",
      [user.id],
    );
    const limited = await post(cookie, '/email/send');
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 60);
    assert.equal((await post('', '/phone/send')).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/registration/codes/phone/send',
          headers: { ...headers, origin: 'https://evil.invalid', cookie },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(cookie, '/email/verify', {
          code: '123456',
          email: 'other@example.com',
        })
      ).statusCode,
      400,
    );
    assert.equal((await post(cookie, '/other/send')).statusCode, 400);
    await pool.query(
      "UPDATE registration_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [user.id],
    );
    assert.equal((await post(cookie, '')).statusCode, 401);
  });
});
