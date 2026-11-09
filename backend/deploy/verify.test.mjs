import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const directory = new URL('.', import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), 'skillbetting-deploy-contract-'));
const env = join(temporary, '.env');
const generated = spawnSync(
  process.execPath,
  [directory + 'generate-env.mjs', env],
  { encoding: 'utf8' },
);
assert.equal(generated.status, 0);
const compose = spawnSync(
  'docker',
  [
    'compose',
    '--env-file',
    env,
    '-f',
    directory + 'compose.yml',
    'config',
    '--format',
    'json',
  ],
  { encoding: 'utf8' },
);
assert.equal(compose.status, 0, compose.stderr);
const config = JSON.parse(compose.stdout);
function check(value) {
  return spawnSync(process.execPath, [directory + 'verify-compose.mjs'], {
    input: JSON.stringify(value),
    encoding: 'utf8',
  });
}
test.after(() => rmSync(temporary, { recursive: true, force: true }));

test('generated keys are private, distinct, and cannot overwrite an existing deployment', () => {
  assert.equal(statSync(env).mode & 0o777, 0o600);
  const before = readFileSync(env, 'utf8');
  const again = spawnSync(
    process.execPath,
    [directory + 'generate-env.mjs', env],
    { encoding: 'utf8' },
  );
  assert.notEqual(again.status, 0);
  assert.equal(readFileSync(env, 'utf8'), before);
  assert.equal(check(config).status, 0);
});
test('a published database/application port is rejected', () => {
  const changed = structuredClone(config);
  changed.services.postgres.ports = [{ published: '5432', target: 5432 }];
  assert.notEqual(check(changed).status, 0);
});
test('missing migration gate, public database network and non-HTTPS origin are rejected', () => {
  for (const change of [
    (c) => {
      c.services.backend.depends_on.migrate.condition = 'service_started';
    },
    (c) => {
      c.networks.database.internal = false;
    },
    (c) => {
      c.services.backend.environment.APP_ORIGIN = 'http://dev.stoiximatakia.gr';
    },
  ]) {
    const changed = structuredClone(config);
    change(changed);
    assert.notEqual(check(changed).status, 0);
  }
});
test('weak/shared credentials are rejected without logging secret values', () => {
  for (const change of [
    (c) => {
      c.services.backend.environment.TABLE_CODE_SECRET = 'short';
    },
    (c) => {
      c.services.postgres.environment.APP_DATABASE_PASSWORD =
        c.services.postgres.environment.POSTGRES_PASSWORD;
    },
  ]) {
    const changed = structuredClone(config);
    change(changed);
    const result = check(changed);
    assert.notEqual(result.status, 0);
    assert.ok(
      !result.stderr.includes(
        config.services.postgres.environment.POSTGRES_PASSWORD,
      ),
    );
  }
});
test('disposable smoke topology exposes no host ports and uses a reserved test origin', () => {
  const smoke = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      env,
      '-f',
      directory + 'compose.yml',
      '-f',
      directory + 'compose.smoke.yml',
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(smoke.status, 0, smoke.stderr);
  const value = JSON.parse(smoke.stdout);
  assert.equal((value.services.edge.ports || []).length, 0);
  assert.ok(
    value.services.edge.networks.application.aliases.includes(
      'skillbetting.test',
    ),
  );
});

test('source archives contain portable inputs without AppleDouble or private metadata', () => {
  const fixture = join(temporary, 'bundle-fixture');
  const backend = join(fixture, 'skillbetting-backend');
  const frontend = join(fixture, 'skillbetting-frontend');
  mkdirSync(join(backend, 'deploy'), { recursive: true });
  mkdirSync(join(frontend, 'public'), { recursive: true });
  copyFileSync(directory + 'bundle.mjs', join(backend, 'deploy/bundle.mjs'));
  for (const root of [backend, frontend])
    writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n');
  mkdirSync(join(backend, 'engines/chess/src'), { recursive: true });
  writeFileSync(join(backend, 'engines/chess/src/index.ts'), 'export {};\n');
  writeFileSync(join(frontend, 'public/runtime.css'), 'body{}');
  writeFileSync(join(frontend, 'public/._designer-data'), 'private metadata');
  writeFileSync(join(frontend, 'public/.DS_Store'), 'finder metadata');
  writeFileSync(join(frontend, 'public/.env'), 'never package credentials');
  const archive = join(fixture, 'release.tar.gz');
  const result = spawnSync(
    process.execPath,
    [join(backend, 'deploy/bundle.mjs'), archive],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const tar = gunzipSync(readFileSync(archive));
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).split('\0')[0];
    const prefix = header.toString('utf8', 345, 500).split('\0')[0];
    const size = Number.parseInt(
      header.toString('ascii', 124, 136).replaceAll('\0', '').trim() || '0',
      8,
    );
    if (header[156] === 0 || [48, 53].includes(header[156]))
      names.push(prefix ? prefix + '/' + name : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(names.some((name) => name.endsWith('/public/runtime.css')));
  assert.ok(names.some((name) => name.endsWith('/engines/chess/src/index.ts')));
  for (const name of names) {
    const parts = name.split('/');
    assert.equal(parts[0], 'skillbetting-release');
    assert.ok(
      !parts.some(
        (part) =>
          part.startsWith('._') ||
          ['.DS_Store', '.env', '.local', '.git', '..'].includes(part),
      ),
      `Unexpected archive input: ${name}`,
    );
  }
});
