import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { it } from 'node:test';
import { Pool } from 'pg';

const run = promisify(execFile);
void it('imports existing balances exactly once, grants 250 only to new accounts and preserves migration history', async () => {
  const target = new URL(process.env.TEST_DATABASE_URL ?? '');
  assert.match(target.pathname, /_test$/);
  const schema = 'credit_import_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: target.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  target.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: target.href });
  try {
    await pool.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of (await readdir('migrations'))
      .filter((f) => /^00[1-5]_.*\.sql$/.test(f))
      .sort()) {
      const sql = await readFile('migrations/' + file, 'utf8');
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',
        [file, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const existing = randomUUID(),
      zero = randomUUID();
    for (const [id, amount] of [
      [existing, 12345],
      [zero, 0],
    ] as const) {
      await pool.query(
        "INSERT INTO users(id,username,username_key,password_hash,email,phone,terms_version,terms_accepted_at,demo_credits_minor) VALUES($1,$2,$2,'test-only',$3,$4,'test',now(),$5)",
        [
          id,
          'Old_' + id.slice(0, 8),
          id + '@example.com',
          '+3069' + (id === existing ? '11111111' : '22222222'),
          amount,
        ],
      );
    }
    const migrate = () =>
      run(process.execPath, ['scripts/migrate.mjs'], {
        env: { ...process.env, DATABASE_URL: target.href },
      });
    await migrate();
    const balances = await pool.query<{
      user_id: string;
      balance_minor: string;
    }>(
      "SELECT user_id,balance_minor FROM credit_accounts WHERE kind='available'",
    );
    assert.equal(
      balances.rows.find((r) => r.user_id === existing)?.balance_minor,
      '12345',
    );
    assert.equal(
      balances.rows.find((r) => r.user_id === zero)?.balance_minor,
      '0',
    );
    const before = (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM credit_journals',
      )
    ).rows[0]?.n;
    await migrate();
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM credit_journals',
        )
      ).rows[0]?.n,
      before,
    );
    const fresh = randomUUID();
    await pool.query(
      "INSERT INTO users(id,username,username_key,password_hash,email,phone,terms_version,terms_accepted_at) VALUES($1,'FreshUser','freshuser','test-only','fresh@example.com','+306933333333','test',now())",
      [fresh],
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          "SELECT balance_minor::int AS n FROM credit_accounts WHERE user_id=$1 AND kind='available'",
          [fresh],
        )
      ).rows[0]?.n,
      25000,
    );
    assert.equal(
      (
        await pool.query<{ n: string }>(
          'SELECT sum(amount_minor)::text AS n FROM credit_postings',
        )
      ).rows[0]?.n,
      '0',
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
