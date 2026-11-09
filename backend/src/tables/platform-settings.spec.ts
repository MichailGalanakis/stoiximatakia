import assert from 'node:assert/strict';
import { it } from 'node:test';
import { platformSettings } from './platform-settings';

void it('requires a stable private-table key before starting production', () => {
  assert.equal(platformSettings({}).codeSecret, undefined);
  assert.equal(platformSettings({}).requireGameRuntime, false);
  assert.throws(() => platformSettings({ NODE_ENV: 'production' }), {
    message: 'TABLE_CODE_SECRET is required in production',
  });
  assert.throws(() => platformSettings({ TABLE_CODE_SECRET: 'short' }));
  const secret = 'a'.repeat(64);
  assert.equal(
    platformSettings({ NODE_ENV: 'production', TABLE_CODE_SECRET: secret })
      .codeSecret,
    secret,
  );
  assert.equal(
    platformSettings({ NODE_ENV: 'production', TABLE_CODE_SECRET: secret })
      .requireGameRuntime,
    true,
  );
});
