import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { it } from 'node:test';
import { HealthReadiness, REQUIRED_SCHEMA_MIGRATION } from './health-readiness';

const settings = {
  databaseUrl: 'postgresql://db/skillbetting',
  appOrigin: 'https://dev.stoiximatakia.gr',
  secureCookie: true,
};

void it('checks the current immutable migration and closes its dedicated probe', async () => {
  const calls: { sql: string; values: string[] }[] = [];
  let closed = false;
  const readiness = new HealthReadiness(settings, () => ({
    query: (sql, values) => {
      calls.push({ sql, values });
      return Promise.resolve({ rows: [{ ready: true }] });
    },
    end: () => {
      closed = true;
      return Promise.resolve();
    },
    on: () => undefined,
  }));
  assert.deepEqual(await readiness.check(), { status: 'ready' });
  assert.deepEqual(calls[0]?.values, [REQUIRED_SCHEMA_MIGRATION]);
  const migrations = (await readdir('migrations'))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  assert.equal(REQUIRED_SCHEMA_MIGRATION, migrations.at(-1));
  await readiness.onModuleDestroy();
  assert.equal(closed, true);
});

void it('refuses readiness without a configured database or current schema', async () => {
  const missing = new HealthReadiness({ ...settings, databaseUrl: undefined });
  await assert.rejects(missing.check(), { message: 'Service Unavailable' });
  const old = new HealthReadiness(settings, () => ({
    query: () => Promise.resolve({ rows: [{ ready: false }] }),
    end: () => Promise.resolve(),
    on: () => undefined,
  }));
  await assert.rejects(old.check(), { message: 'Service Unavailable' });
  await old.onModuleDestroy();
});

void it('does not propagate connection credentials or database errors', async () => {
  const failed = new HealthReadiness(settings, () => ({
    query: () =>
      Promise.reject(
        new Error('postgresql://private-user:private-password@secret-host/db'),
      ),
    end: () => Promise.resolve(),
    on: () => undefined,
  }));
  await assert.rejects(failed.check(), { message: 'Service Unavailable' });
  await failed.onModuleDestroy();
});
