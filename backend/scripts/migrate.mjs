import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';

let pool;
let client;
try {
  if (!process.env.DATABASE_URL) throw new Error('missing_database');
  const url = new URL(process.env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname.length < 2
  )
    throw new Error('invalid_database');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', () => {});
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='30s'");
  await client.query('SELECT pg_advisory_xact_lock(824613091)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory))
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const { rows } = await client.query(
      'SELECT sha256 FROM schema_migrations WHERE name=$1',
      [name],
    );
    if (rows[0]) {
      if (rows[0].sha256 !== digest)
        throw new Error('An applied migration changed');
      continue;
    }
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (name, sha256) VALUES ($1,$2)',
      [name, digest],
    );
    console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
} catch {
  try {
    await client?.query('ROLLBACK');
  } catch {
    // Preserve the original failure without printing credentials or SQL errors.
  }
  console.error('Migration failed; no partial migration was committed.');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
