import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
for (const config of ['tsconfig.esm.json', 'tsconfig.cjs.json']) {
  const run = spawnSync(
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    ['-p', config],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (run.error) {
    console.error(
      'Install the pinned TypeScript dev dependency before building:',
      run.error.message,
    );
    process.exit(1);
  }
  if (run.status !== 0) process.exit(run.status ?? 1);
}
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
writeFileSync('dist/esm/package.json', '{"type":"module"}\n');
