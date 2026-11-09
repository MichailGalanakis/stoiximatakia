import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { before, beforeEach, after, describe, it } from 'node:test';
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
} from '../src/registration/verification-delivery';
import { tokenDigest } from '../src/registration/registration.service';

interface Account {
  id: string;
  username: string;
  kind: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  demoCreditsMinor: number;
}
const cookiePair = (value: string | string[] | undefined, name: string) => {
  const cookie = (Array.isArray(value) ? value : [value ?? '']).find((c) =>
    c.startsWith(name + '='),
  );
  assert.ok(cookie, `Missing ${name} cookie`);
  return cookie.split(';')[0]!;
};

void describe('account sessions and one-click demo against PostgreSQL', () => {
  let app: NestFastifyApplication, pool: Pool, admin: Pool, url: string;
  const schema = 'sessions_' + randomUUID().replaceAll('-', '');
  const headers = {
    origin: 'https://test.skillbetting.invalid',
    'x-skillbetting-client': 'web-v1',
  };
  const logs: unknown[] = [];
  let deliveries = 0,
    counter = 0;
  async function application() {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({
        databaseUrl: url,
        appOrigin: headers.origin,
        secureCookie: true,
      })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({ secret: 'test-only-secret-'.repeat(5) })
      .overrideProvider(VERIFICATION_DELIVERY)
      .useValue({
        available: () => true,
        send: () => {
          deliveries++;
          return Promise.resolve();
        },
      })
      .compile();
    const instance = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(instance, {
      log: (x: unknown) => logs.push(x),
      error: (x: unknown) => logs.push(x),
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
    for (const file of (await readdir('migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort())
      await pool.query(await readFile('migrations/' + file, 'utf8'));
    app = await application();
  });
  beforeEach(async () => {
    deliveries = 0;
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
  const post = (path: string, cookie = '', payload: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: '/auth/' + path,
      headers: { ...headers, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const get = (path: string, cookie = '') =>
    app.inject({ method: 'GET', url: '/auth/' + path, headers: { cookie } });
  async function signup(cookie = '') {
    counter++;
    return post('registrations', cookie, {
      username: 'SessionUser' + counter,
      password: 'test-only-password-12345',
      email: `session${counter}@example.com`,
      phone: '+30691' + String(counter).padStart(7, '0'),
      termsAccepted: true,
      termsVersion: TERMS_VERSION,
    });
  }

  void it('signs in immediately with a separate hashed credential and restores after restart', async () => {
    const response = await signup();
    assert.equal(response.statusCode, 201);
    const account = response.json<{ account: Account }>().account;
    assert.equal(account.kind, 'registered');
    assert.equal(account.emailVerified, true);
    assert.equal(account.phoneVerified, false);
    assert.equal(account.demoCreditsMinor, 25000);
    assert.equal(deliveries, 0);
    const cookie = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_session',
    );
    const regCookie = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_registration',
    );
    assert.notEqual(cookie.split('=')[1], regCookie.split('=')[1]);
    const flags = (response.headers['set-cookie'] as string[]).find((c) =>
      c.startsWith('__Host-sb_session='),
    )!;
    for (const flag of [
      'Secure',
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=2592000',
    ])
      assert.ok(flags.includes(flag));
    const row = (
      await pool.query('SELECT * FROM account_sessions WHERE user_id=$1', [
        account.id,
      ])
    ).rows[0] as { token_hash: string };
    assert.equal(row.token_hash, tokenDigest(cookie.split('=')[1]!));
    assert.ok(!response.body.includes(cookie.split('=')[1]!));
    assert.ok(!response.body.includes('password'));
    assert.equal(
      (await get('session', regCookie)).json<{ account: null }>().account,
      null,
    );
    assert.equal(
      (await get('registration', cookie)).json<{
        registration: { id: string };
      }>().registration.id,
      account.id,
    );
    await app.close();
    app = await application();
    assert.deepEqual((await get('session', cookie)).json(), { account });
    await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
      account.id,
    ]);
    assert.equal(
      (await get('session', cookie)).json<{ account: Account }>().account
        .emailVerified,
      false,
    );
  });

  void it('creates an isolated random demo account, resumes it and never sends contact codes', async () => {
    const response = await post('demo');
    assert.equal(response.statusCode, 200);
    const account = response.json<{ account: Account }>().account;
    assert.equal(account.kind, 'demo');
    assert.match(account.username, /^Demo_[a-f0-9]{16}$/);
    assert.equal(account.demoCreditsMinor, 25000);
    const cookie = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_session',
    );
    const row = (
      await pool.query('SELECT * FROM users WHERE id=$1', [account.id])
    ).rows[0] as {
      email: string;
      phone: string;
      password_hash: string;
      terms_accepted_at: null;
    };
    assert.equal(row.email, account.id + '@demo.invalid');
    assert.equal(row.phone, 'demo:' + account.id);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.equal(row.terms_accepted_at, null);
    assert.equal(account.emailVerified, false);
    assert.equal(account.phoneVerified, false);
    assert.equal(
      (await get('registration', cookie)).json<{ registration: null }>()
        .registration,
      null,
    );
    assert.equal((await post('registration/codes', cookie)).statusCode, 401);
    assert.equal(
      (await post('registration/codes/email/send', cookie)).statusCode,
      401,
    );
    assert.equal(deliveries, 0);
    assert.deepEqual((await post('demo', cookie)).json(), { account });
    assert.equal(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*) FROM account_sessions WHERE user_id=$1',
          [account.id],
        )
      ).rows[0]!.count,
      '1',
    );
    const fresh = (await post('demo')).json<{ account: Account }>().account;
    assert.notEqual(fresh.id, account.id);
    assert.notEqual(fresh.username, account.username);
    assert.equal(
      (await get('session')).json<{ account: null }>().account,
      null,
    );
  });

  void it('keeps a signed-in registered account when Demo is clicked and rotates a demo session on signup', async () => {
    const demo = await post('demo');
    const oldCookie = cookiePair(
      demo.headers['set-cookie'],
      '__Host-sb_session',
    );
    const registered = await signup(oldCookie);
    assert.equal(registered.statusCode, 201);
    const cookie = cookiePair(
      registered.headers['set-cookie'],
      '__Host-sb_session',
    );
    assert.equal(
      (await get('session', oldCookie)).json<{ account: null }>().account,
      null,
    );
    const account = registered.json<{ account: Account }>().account;
    assert.deepEqual((await post('demo', cookie)).json(), { account });
  });

  void it('requires explicit protected resume for older registration cookies and revokes both on logout', async () => {
    const response = await signup();
    const reg = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_registration',
    );
    const original = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_session',
    );
    const resumed = await post('session', reg);
    assert.equal(resumed.statusCode, 200);
    const cookie = cookiePair(
      resumed.headers['set-cookie'],
      '__Host-sb_session',
    );
    assert.equal((await post('session')).statusCode, 401);
    const logout = await post('logout', cookie + '; ' + reg);
    assert.equal(logout.statusCode, 200);
    assert.equal(
      (await get('session', cookie)).json<{ account: null }>().account,
      null,
    );
    assert.equal((await post('session', reg)).statusCode, 401);
    assert.equal(
      (await get('registration', reg)).json<{ registration: null }>()
        .registration,
      null,
    );
    // Logout affects only the presented session, not another device's independent credential.
    assert.ok(
      (await get('session', original)).json<{ account: Account }>().account,
    );
  });

  void it('rejects missing/forged/expired credentials and untrusted writes/privilege fields', async () => {
    for (const cookie of [
      '',
      '__Host-sb_session=bad',
      '__Host-sb_session=' + '0'.repeat(64),
    ])
      assert.equal(
        (await get('session', cookie)).json<{ account: null }>().account,
        null,
      );
    const demo = await post('demo');
    const cookie = cookiePair(demo.headers['set-cookie'], '__Host-sb_session');
    await pool.query(
      "UPDATE account_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [tokenDigest(cookie.split('=')[1]!)],
    );
    assert.equal(
      (await get('session', cookie)).json<{ account: null }>().account,
      null,
    );
    for (const path of ['demo', 'session', 'logout']) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/' + path,
            headers: { origin: 'https://evil.invalid' },
            payload: {},
          })
        ).statusCode,
        403,
      );
      for (const payload of [
        { userId: randomUUID() },
        { emailVerified: true },
        { demoCreditsMinor: 999999 },
        [],
      ])
        assert.equal((await post(path, '', payload)).statusCode, 400);
    }
  });

  void it('rolls back both account types if account-session persistence fails', async () => {
    await pool.query(`CREATE FUNCTION reject_account_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private session failure'; END $$;
      CREATE TRIGGER reject_account_session BEFORE INSERT ON account_sessions FOR EACH ROW EXECUTE FUNCTION reject_account_session()`);
    const count = (
      await pool.query<{ count: string }>('SELECT count(*) FROM users')
    ).rows[0]!.count;
    try {
      for (const response of [await signup(), await post('demo')]) {
        assert.equal(response.statusCode, 503);
        assert.ok(!response.body.includes('private'));
      }
      assert.equal(
        (await pool.query<{ count: string }>('SELECT count(*) FROM users'))
          .rows[0]!.count,
        count,
      );
    } finally {
      await pool.query(
        'DROP TRIGGER reject_account_session ON account_sessions; DROP FUNCTION reject_account_session()',
      );
    }
  });

  void it('loads and saves only the signed-in profile, including after restart', async () => {
    const first = await signup();
    const second = await post('demo');
    const cookie = cookiePair(first.headers['set-cookie'], '__Host-sb_session');
    const other = cookiePair(second.headers['set-cookie'], '__Host-sb_session');
    const id = first.json<{ account: Account }>().account.id;
    const profile = await get('profile', cookie);
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.headers['cache-control'], 'no-store');
    assert.deepEqual(profile.json<{ details: unknown }>().details, {
      fullName: '',
      country: '',
      city: '',
    });
    const updated = await post('profile', cookie, {
      fullName: '  Παίκτης Δοκιμής  ',
      country: ' Ελλάδα ',
      city: ' Αθήνα ',
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json<{ details: unknown }>().details, {
      fullName: 'Παίκτης Δοκιμής',
      country: 'Ελλάδα',
      city: 'Αθήνα',
    });
    assert.equal(updated.json<{ account: Account }>().account.id, id);
    await app.close();
    app = await application();
    assert.deepEqual((await get('profile', cookie)).json(), updated.json());
    assert.deepEqual(
      (await get('profile?userId=' + id, other)).json<{ details: unknown }>()
        .details,
      { fullName: '', country: '', city: '' },
    );
    assert.equal(
      (await get('profile?userId=' + id, other)).json<{ account: Account }>()
        .account.id,
      second.json<{ account: Account }>().account.id,
    );
    const savedDemo = await post('profile', other, {
      fullName: 'Guest name',
      country: '',
      city: 'Local',
    });
    assert.equal(savedDemo.statusCode, 200);
    assert.equal((await post('registration/codes', other)).statusCode, 401);
    assert.equal(deliveries, 0);
  });

  void it('protects profile writes, locks account contacts and rejects expired credentials without leaking details', async () => {
    const response = await post('demo');
    const cookie = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_session',
    );
    const details = { fullName: 'Name', country: 'GR', city: 'Athens' };
    for (const extra of [
      { id: randomUUID() },
      { nickname: 'rename' },
      { email: 'other@example.com' },
      { phone: '+306912345678' },
      { emailVerified: true },
      { demoCreditsMinor: 999 },
      { fullName: 'x'.repeat(81) },
      { country: 'x'.repeat(61) },
      { city: 'x'.repeat(81) },
      { city: 1 },
    ])
      assert.equal(
        (await post('profile', cookie, { ...details, ...extra })).statusCode,
        400,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/profile',
          headers: { cookie, origin: 'https://evil.invalid' },
          payload: details,
        })
      ).statusCode,
      403,
    );
    for (const invalid of [
      '',
      '__Host-sb_session=bad',
      '__Host-sb_session=' + '0'.repeat(64),
      cookiePair(response.headers['set-cookie'], '__Host-sb_registration'),
    ]) {
      assert.equal((await get('profile', invalid)).statusCode, 401);
      assert.equal((await post('profile', invalid, details)).statusCode, 401);
    }
    await pool.query(
      "UPDATE account_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [tokenDigest(cookie.split('=')[1]!)],
    );
    assert.equal((await get('profile', cookie)).statusCode, 401);
    assert.equal((await post('profile', cookie, details)).statusCode, 401);
    const logText = JSON.stringify(logs);
    assert.ok(!logText.includes('Παίκτης Δοκιμής'));
    assert.ok(!logText.includes('Guest name'));
  });

  void it('permanently dismisses registration across logout, login and application restart', async () => {
    const response = await signup();
    const account = response.json<{ account: Account }>().account;
    const cookie = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_session',
    );
    const reg = cookiePair(
      response.headers['set-cookie'],
      '__Host-sb_registration',
    );
    assert.ok(
      (await get('registration', cookie)).json<{ registration: unknown }>()
        .registration,
    );
    assert.equal((await post('registration/dismiss', cookie)).statusCode, 200);
    assert.equal((await post('registration/dismiss', cookie)).statusCode, 200);
    assert.equal(
      (await get('registration', cookie)).json<{ registration: null }>()
        .registration,
      null,
    );
    assert.equal(
      (await get('registration', reg)).json<{ registration: null }>()
        .registration,
      null,
    );
    assert.equal(
      (await post('registration/dismiss', '', { userId: account.id }))
        .statusCode,
      400,
    );
    assert.equal((await post('registration/dismiss')).statusCode, 401);
    await post('logout', cookie + '; ' + reg);
    const loggedIn = await post('login', '', {
      username: '  ' + account.username.toUpperCase() + '  ',
      password: 'test-only-password-12345',
    });
    assert.equal(loggedIn.statusCode, 200);
    assert.equal(loggedIn.json<{ account: Account }>().account.id, account.id);
    const nextCookie = cookiePair(
      loggedIn.headers['set-cookie'],
      '__Host-sb_session',
    );
    assert.notEqual(nextCookie, cookie);
    assert.equal(
      (await get('session', cookie)).json<{ account: null }>().account,
      null,
    );
    await app.close();
    app = await application();
    assert.equal(
      (await get('registration', nextCookie)).json<{ registration: null }>()
        .registration,
      null,
    );
    assert.equal((await get('profile', nextCookie)).statusCode, 200);
    assert.equal(deliveries, 0);
  });

  void it('does not restart an unfinished registration when an existing account signs in', async () => {
    const created = await signup();
    const account = created.json<{ account: Account }>().account;
    const cookie = cookiePair(
      created.headers['set-cookie'],
      '__Host-sb_session',
    );
    assert.ok(
      (await get('registration', cookie)).json<{ registration: unknown }>()
        .registration,
    );
    const login = await post('login', cookie, {
      username: account.username,
      password: 'test-only-password-12345',
    });
    assert.equal(login.statusCode, 200);
    const next = cookiePair(login.headers['set-cookie'], '__Host-sb_session');
    assert.equal(
      (await get('registration', next)).json<{ registration: null }>()
        .registration,
      null,
    );
    assert.equal(
      (await get('session', cookie)).json<{ account: null }>().account,
      null,
    );
  });

  void it('rejects incorrect login credentials generically, protects origins and limits repeated attempts', async () => {
    const registered = await signup();
    const username = registered.json<{ account: Account }>().account.username;
    for (const input of [
      { username, password: 'wrong' },
      { username: 'UnknownUser', password: 'wrong' },
    ]) {
      const result = await post('login', '', input);
      assert.equal(result.statusCode, 401);
      assert.equal(result.json<{ code: string }>().code, 'invalid_credentials');
      assert.equal(result.headers['set-cookie'], undefined);
    }
    assert.equal(
      (
        await post('login', '', {
          username,
          password: 'test-only-password-12345',
          emailVerified: true,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { origin: 'https://evil.invalid' },
          payload: { username, password: 'test-only-password-12345' },
        })
      ).statusCode,
      403,
    );
    await pool.query(
      "INSERT INTO registration_limits(key,bucket,attempts) VALUES($1,date_trunc('hour',now()),10) ON CONFLICT(key,bucket) DO UPDATE SET attempts=10",
      [tokenDigest('login-ip:127.0.0.1')],
    );
    assert.equal(
      (
        await post('login', '', {
          username,
          password: 'test-only-password-12345',
        })
      ).statusCode,
      429,
    );
  });

  void it('shares creation limits and keeps sessions, passwords and placeholders out of logs', async () => {
    await pool.query(
      "INSERT INTO registration_limits(key,bucket,attempts) VALUES($1,date_trunc('hour',now()),10)",
      [tokenDigest('127.0.0.1')],
    );
    assert.equal((await post('demo')).statusCode, 429);
    assert.equal((await signup()).statusCode, 429);
    const text = JSON.stringify(logs);
    for (const value of [
      'test-only-password',
      'sb_session=',
      'sb_registration=',
      '@demo.invalid',
      'private session failure',
    ])
      assert.ok(!text.includes(value));
  });
});
