import assert from 'node:assert/strict';
import { it } from 'node:test';
import { registrationSettings } from './registration-settings';

void it('requires an exact browser origin and HTTPS cookies in production', () => {
  assert.equal(registrationSettings({}).secureCookie, false);
  assert.equal(
    registrationSettings({
      APP_ORIGIN: 'https://dev.stoiximatakia.gr',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:password@database/skillbetting',
    }).secureCookie,
    true,
  );
  for (const value of [
    'https://site.invalid/path',
    'https://user:pass@site.invalid',
    'ftp://site.invalid',
  ])
    assert.throws(() => registrationSettings({ APP_ORIGIN: value }));
  assert.throws(() => registrationSettings({ NODE_ENV: 'production' }));
  assert.throws(
    () =>
      registrationSettings({
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://dev.stoiximatakia.gr',
      }),
    { message: 'DATABASE_URL is required in production' },
  );
  assert.throws(() =>
    registrationSettings({ DATABASE_URL: 'postgresql://database' }),
  );
  assert.throws(
    () => registrationSettings({ DATABASE_URL: 'private-invalid-value' }),
    { message: 'Invalid registration URL configuration' },
  );
  assert.throws(() =>
    registrationSettings({ DATABASE_URL: 'mysql://localhost/database' }),
  );
});
