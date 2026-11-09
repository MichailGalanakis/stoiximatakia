import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const local = resolve(root, '.local');
const data = resolve(local, 'postgres');
const socket = resolve(local, 'socket');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed; check PostgreSQL is installed and on PATH`,
    );
  return result.stdout?.trim();
}
mkdirSync(local, { recursive: true, mode: 0o700 });
chmodSync(local, 0o700);
if (process.argv[2] === 'stop') {
  run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
} else {
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  if (!existsSync(resolve(data, 'PG_VERSION')))
    run('initdb', [
      '-D',
      data,
      '-A',
      'trust',
      '--encoding=UTF8',
      '--no-locale',
    ]);
  const status = spawnSync('pg_ctl', ['-D', data, 'status'], {
    stdio: 'ignore',
  });
  if (status.status !== 0)
    run('pg_ctl', [
      '-D',
      data,
      '-l',
      resolve(local, 'postgres.log'),
      '-o',
      `-h '' -k '${socket}' -p 55432`,
      '-w',
      'start',
    ]);
  for (const name of ['skillbetting', 'skillbetting_test']) {
    const exists = run(
      'psql',
      [
        '-h',
        socket,
        '-p',
        '55432',
        '-d',
        'postgres',
        '-Atc',
        `SELECT 1 FROM pg_database WHERE datname='${name}'`,
      ],
      true,
    );
    if (!exists) run('createdb', ['-h', socket, '-p', '55432', name]);
  }
  const url = (database) => {
    const result = new URL(`postgresql://localhost/${database}`);
    result.username = userInfo().username;
    result.searchParams.set('host', socket);
    result.searchParams.set('port', '55432');
    return result.href;
  };
  writeFileSync(
    resolve(local, 'database.env'),
    `DATABASE_URL=${url('skillbetting')}\nTEST_DATABASE_URL=${url('skillbetting_test')}\n`,
    { mode: 0o600 },
  );
  console.log(
    'Local PostgreSQL ready on a private Unix socket. Settings: .local/database.env',
  );
}
