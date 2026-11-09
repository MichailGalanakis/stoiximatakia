// Container-only migration entry point; native db:migrate remains unchanged.
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';

const migrated = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
  stdio: 'inherit',
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  max: 1,
});
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  const { rows } = await client.query(
    "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='skillbetting_app'",
  );
  if (rows.length !== 1 || Object.values(rows[0]).some(Boolean))
    throw new Error('Application role is not restricted');
  await client.query('GRANT USAGE ON SCHEMA public TO skillbetting_app');
  await client.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO skillbetting_app',
  );
  await client.query(
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO skillbetting_app',
  );
  await client.query(
    'REVOKE INSERT,UPDATE,DELETE ON TABLE schema_migrations FROM skillbetting_app',
  );
  await client.query('COMMIT');
  console.log(
    'Production application grants applied; migration history is read-only to the application.',
  );
} catch {
  await client?.query('ROLLBACK').catch(() => {});
  console.error(
    'Production database grant preparation failed. Application startup remains gated.',
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
