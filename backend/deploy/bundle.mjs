// Run on the development machine; the server needs Docker/Compose and a shell.
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const backend = resolve(new URL('..', import.meta.url).pathname);
const frontend = resolve(backend, '../skillbetting-frontend');
const destination = resolve(
  process.argv[2] ||
    join(tmpdir(), `skillbetting-release-${Date.now()}.tar.gz`),
);
if (existsSync(destination))
  throw new Error('Destination already exists; use a new bundle filename.');
for (const root of [backend, frontend])
  if (!existsSync(join(root, 'Dockerfile')))
    throw new Error(
      'Both sibling repositories must contain their release Dockerfiles.',
    );
const temporary = mkdtempSync(join(tmpdir(), 'skillbetting-release-source-'));
const output = join(temporary, 'skillbetting-release');
const entries = [];
function copyTree(root, relative, repository) {
  const source = join(root, relative);
  if (!existsSync(source)) return;
  const name = basename(source);
  if (name === '.DS_Store' || name.startsWith('._')) return;
  if (
    [
      '.git',
      '.local',
      'node_modules',
      '.next',
      '.test-dist',
      'dist',
      'reference',
      'coverage',
      'test-results',
      'playwright-report',
    ].includes(name)
  )
    return;
  if (name.endsWith('.spec.ts')) return;
  const normalized = relative.split('\\').join('/');
  if (
    repository === 'skillbetting-frontend' &&
    (/^app\/(?:preview|qa)(?:\/|$)/.test(normalized) ||
      /^app\/api\/qa(?:\/|$)/.test(normalized) ||
      normalized === 'public/header-preview.css')
  )
    return;
  if (
    name === '.env' ||
    (name.startsWith('.env.') && name !== '.env.example') ||
    /\.(log|dump|tsbuildinfo)$/.test(name)
  )
    return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink())
    throw new Error(
      `Release inputs must be regular files: ${repository}/${relative}`,
    );
  if (stat.isDirectory()) {
    for (const child of readdirSync(source).sort())
      copyTree(root, join(relative, child), repository);
    return;
  }
  const bytes = readFileSync(source);
  const target = join(output, repository, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { mode: stat.mode & 0o777 });
  entries.push({
    path: `${repository}/${relative}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}
try {
  for (const path of [
    'Dockerfile',
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'src',
    'migrations',
    'scripts/migrate.mjs',
    'docs/release-checkpoint.md',
    'docs/verification/deployment-2026-11-02/container-checks.json',
    'docs/verification/deployment-2026-11-02/release-checks.json',
  ])
    copyTree(backend, path, 'skillbetting-backend');
  for (const name of [
    'compose.yml',
    'compose.smoke.yml',
    'Caddyfile',
    'Caddyfile.smoke',
    '.env.example',
    'postgres-init.sh',
    'backup.sh',
    'restore.sh',
    'manage.sh',
    'smoke.sh',
    'generate-env.mjs',
    'verify-compose.mjs',
    'smoke-api.mjs',
    'bundle.mjs',
    'verify.test.mjs',
    'migrate-production.mjs',
    'README.md',
    'SERVER-AGENT.md',
  ])
    copyTree(backend, join('deploy', name), 'skillbetting-backend');
  for (const game of ['xeri', 'diloti', 'rummy', 'tichu', 'chess'])
    for (const path of [
      'src',
      'scripts',
      'package.json',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.cjs.json',
      'tsconfig.esm.json',
    ])
      copyTree(backend, join('engines', game, path), 'skillbetting-backend');
  for (const path of [
    'Dockerfile',
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'next.config.ts',
    'tsconfig.json',
    'app',
    'components',
    'lib',
    'styles',
    'assets',
    'public',
    'docs/deployment.md',
    'scripts/sync-designer-assets.mjs',
    'scripts/verify-deployment.mjs',
  ])
    copyTree(frontend, path, 'skillbetting-frontend');
  const manifest = {
    createdAt: new Date().toISOString(),
    repositories: {
      backend: {
        head: git(backend, ['rev-parse', 'HEAD']),
        dirty: git(backend, ['status', '--porcelain']) !== '',
      },
      frontend: {
        head: git(frontend, ['rev-parse', 'HEAD']),
        dirty: git(frontend, ['status', '--porcelain']) !== '',
      },
    },
    scope:
      'Exact working source snapshot. No credentials, local databases/QA, designer reference, engine archives, compiled local outputs or Git metadata.',
    files: entries,
  };
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  const archive = spawnSync(
    'tar',
    ['-czf', destination, '-C', temporary, 'skillbetting-release'],
    {
      stdio: 'inherit',
      // BSD tar otherwise writes AppleDouble sidecars that GNU tar on the
      // deployment host would extract as unexpected source/public files.
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );
  if (archive.status !== 0) throw new Error('Release archive creation failed.');
  console.log(
    JSON.stringify({
      archive: destination,
      files: entries.length,
      sha256: createHash('sha256')
        .update(readFileSync(destination))
        .digest('hex'),
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
