// Receive `docker compose config --format json` on stdin; never print secrets.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

try {
  const config = JSON.parse(readFileSync(0, 'utf8'));
  const services = config.services;
  for (const [name, service] of Object.entries(services)) {
    assert.ok(!service.privileged && service.network_mode !== 'host');
    assert.ok(
      !(service.volumes || []).some((v) => v.source?.includes('docker.sock')),
    );
    if (name !== 'edge') assert.equal((service.ports || []).length, 0);
  }
  assert.deepEqual(
    new Set(services.edge.ports.map((p) => Number(p.published))),
    new Set([80, 443]),
  );
  assert.equal(config.networks.database.internal, true);
  assert.equal(services.backend.environment.TRUST_PROXY_HOPS, '1');
  const origin = new URL(services.backend.environment.APP_ORIGIN);
  assert.equal(origin.protocol, 'https:');
  assert.equal(origin.origin, `https://${services.edge.environment.SITE_HOST}`);
  for (const name of ['backend', 'frontend']) {
    assert.equal(services[name].read_only, true);
    assert.equal(services[name].init, true);
    assert.ok(services[name].healthcheck);
  }
  assert.equal(
    services.backend.depends_on.migrate.condition,
    'service_completed_successfully',
  );
  for (const value of [
    services.postgres.environment.POSTGRES_PASSWORD,
    services.postgres.environment.APP_DATABASE_PASSWORD,
    services.backend.environment.OTP_SECRET,
  ])
    assert.match(value, /^[a-f0-9]{64}$/i);
  assert.match(
    services.backend.environment.TABLE_CODE_SECRET,
    /^[a-f0-9]{96}$/i,
  );
  assert.notEqual(
    services.postgres.environment.POSTGRES_PASSWORD,
    services.postgres.environment.APP_DATABASE_PASSWORD,
  );
  assert.equal(
    new URL(services.backend.environment.DATABASE_URL).username,
    'skillbetting_app',
  );
  assert.equal(
    new URL(services.migrate.environment.DATABASE_URL).username,
    'postgres',
  );
  assert.match(
    services.postgres.image,
    /^postgres:17\.11-bookworm@sha256:[a-f0-9]{64}$/,
  );
  assert.match(
    services.edge.image,
    /^caddy:2\.11\.7-alpine@sha256:[a-f0-9]{64}$/,
  );
  console.log(
    'Deployment configuration passes: private database, migration gate, strong persistent keys, exact HTTPS origin, only edge ports exposed.',
  );
} catch {
  console.error(
    'Deployment configuration failed validation. Check the private env file and documented Compose topology; secret values are not logged.',
  );
  process.exitCode = 1;
}
