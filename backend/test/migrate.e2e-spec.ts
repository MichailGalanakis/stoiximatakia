import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

void it('migration configuration failures exit cleanly without leaking supplied secrets', () => {
  for (const databaseUrl of [
    '',
    'not-a-url-private-password',
    'mysql://private-user:private-password@private-host/private-db',
  ]) {
    const result = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr.trim(),
      'Migration failed; no partial migration was committed.',
    );
  }
});
