import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { it } from 'node:test';
import { Pool } from 'pg';
import {
  HealthReadiness,
  REQUIRED_SCHEMA_MIGRATION,
} from '../src/health/health-readiness';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import { PlatformStore } from '../src/tables/platform.store';

const run = promisify(execFile);
void it('becomes ready only after successful immutable migrations and preserves repeated migration state', async () => {
  const target = new URL(process.env.TEST_DATABASE_URL ?? '');
  assert.match(target.pathname, /_test$/);
  const schema = 'release_readiness_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: target.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  target.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: target.href });
  const readiness = new HealthReadiness({
    databaseUrl: target.href,
    appOrigin: 'https://dev.stoiximatakia.gr',
    secureCookie: true,
  });
  const migrate = () =>
    run(process.execPath, ['scripts/migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: target.href },
    });
  try {
    await assert.rejects(readiness.check(), { message: 'Service Unavailable' });
    const first = await migrate();
    assert.ok(first.stdout.includes(REQUIRED_SCHEMA_MIGRATION));
    assert.deepEqual(await readiness.check(), { status: 'ready' });
    const before = (
      await pool.query(
        'SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name',
      )
    ).rows;
    const again = await migrate();
    assert.equal(again.stdout, '');
    assert.deepEqual(
      (
        await pool.query(
          'SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name',
        )
      ).rows,
      before,
    );
    await pool.query('DELETE FROM schema_migrations WHERE name=$1', [
      REQUIRED_SCHEMA_MIGRATION,
    ]);
    await assert.rejects(readiness.check(), { message: 'Service Unavailable' });
  } finally {
    await readiness.onModuleDestroy();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

void it('production refuses funding and readiness for unregistered games while retaining legacy history and full withdrawal', async () => {
  const target = new URL(process.env.TEST_DATABASE_URL ?? '');
  assert.match(target.pathname, /_test$/);
  const schema = 'release_game_hold_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: target.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  target.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: target.href });
  const settings = {
    databaseUrl: target.href,
    appOrigin: 'https://dev.stoiximatakia.gr',
    secureCookie: true,
  };
  const registry = new GameRuntimeRegistry();
  const held = new PlatformStore(
    settings,
    { codeSecret: 's'.repeat(64), requireGameRuntime: true },
    registry,
  );
  const foundation = new PlatformStore(
    settings,
    { codeSecret: 's'.repeat(64), requireGameRuntime: false },
    registry,
  );
  try {
    await run(process.execPath, ['scripts/migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: target.href },
    });
    const users = [randomUUID(), randomUUID()];
    const hashes = ['a'.repeat(64), 'b'.repeat(64)];
    for (let i = 0; i < 2; i++) {
      const id = users[i]!;
      await pool.query(
        "INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at) VALUES($1,$2,$2,'test-only',$3,$4,'demo',null,null)",
        [id, 'Release_' + i, id + '@demo.invalid', 'demo:' + id],
      );
      await pool.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hashes[i], id],
      );
    }
    const input = {
      operationId: randomUUID(),
      gameId: 'chess' as const,
      name: 'Held chess fixture',
      visibility: 'public' as const,
      formatId: 'standard',
      prizeContributionMinor: 100,
    };
    const snapshot = async () => ({
      accounts: (
        await pool.query(
          'SELECT key,balance_minor FROM credit_accounts ORDER BY key',
        )
      ).rows,
      journals: (await pool.query('SELECT id FROM credit_journals ORDER BY id'))
        .rows,
      tables: (
        await pool.query(
          'SELECT id,revision,status FROM game_tables ORDER BY id',
        )
      ).rows,
      tickets: (
        await pool.query('SELECT id,state FROM table_tickets ORDER BY id')
      ).rows,
      participants: (
        await pool.query(
          'SELECT user_id,seat_index,ready FROM table_participations ORDER BY user_id',
        )
      ).rows,
    });
    const initial = await snapshot();
    await assert.rejects(held.create(hashes[0]!, input), {
      code: 'engine_unavailable',
    });
    assert.deepEqual(await snapshot(), initial);
    const legacy = await foundation.create(hashes[0]!, {
      ...input,
      operationId: randomUUID(),
    });
    const before = await snapshot();
    for (const action of [
      () => held.join(hashes[1]!, legacy.table.id, randomUUID(), 1),
      () => held.move(hashes[0]!, legacy.table.id, randomUUID(), 1),
      () => held.ready(hashes[0]!, legacy.table.id, randomUUID()),
    ]) {
      await assert.rejects(action(), { code: 'engine_unavailable' });
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal(
      (await held.get(hashes[0]!, legacy.table.id)).table.id,
      legacy.table.id,
    );
    assert.equal((await held.tickets(hashes[0]!)).tickets.length, 1);
    const cancelled = await held.cancel(
      hashes[0]!,
      legacy.table.id,
      randomUUID(),
    );
    assert.equal(cancelled.table.status, 'cancelled');
    assert.deepEqual(cancelled.balance, {
      availableMinor: 25000,
      reservedMinor: 0,
    });
    assert.equal(
      (await held.tickets(hashes[0]!)).tickets[0]?.state,
      'cancelled',
    );
  } finally {
    await held.onModuleDestroy();
    await foundation.onModuleDestroy();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
