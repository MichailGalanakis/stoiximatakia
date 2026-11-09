import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(
  process.argv[2] || new URL('.env', import.meta.url).pathname,
);
const hostname = process.argv[3] || 'dev.stoiximatakia.gr';
if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostname))
  throw new Error('Supply a DNS hostname without a scheme, path or port.');
const key = (bytes = 32) => randomBytes(bytes).toString('hex');
const release = new Date()
  .toISOString()
  .replace(/[^0-9]/g, '')
  .slice(0, 14);
const text = `# Private server settings. Preserve across releases; never include in bundles.
SITE_HOST=${hostname}
APP_ORIGIN=https://${hostname}
RELEASE_ID=poc-${release}
POSTGRES_PASSWORD=${key()}
APP_DATABASE_PASSWORD=${key()}
TABLE_CODE_SECRET=${key(48)}
OTP_SECRET=${key()}
LOG_LEVEL=info
BACKUP_KEEP=14
BACKUP_INTERVAL_SECONDS=86400
RESEND_API_KEY=
RESEND_FROM=
SEVEN_API_KEY=
SEVEN_SENDER=SkillBet
`;
try {
  writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
} catch {
  console.error(
    'Settings not written. The destination must be new and writable; existing secrets are never overwritten.',
  );
  process.exit(1);
}
console.log(
  'Private deployment settings created. Preserve this file across updates.',
);
