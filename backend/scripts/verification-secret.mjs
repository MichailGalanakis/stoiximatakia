import { randomBytes } from 'node:crypto';
import { readFile, appendFile, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const path = new URL('../.env', import.meta.url);
const content = await readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const existing = parseEnv(content).OTP_SECRET;
if (existing) {
  if (existing.length < 64)
    throw new Error(
      'Existing OTP_SECRET is too short; replace it intentionally.',
    );
  console.log('Existing OTP signing secret preserved.');
} else {
  await appendFile(
    path,
    `\n# Server-only verification code signing key. Keep stable across restarts.\nOTP_SECRET=${randomBytes(32).toString('hex')}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  console.log(
    'OTP signing secret prepared in ignored .env; no secret value displayed.',
  );
}
