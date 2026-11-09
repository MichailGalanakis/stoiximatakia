import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const options = { N: 131_072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const parts = hash.split('$');
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join('$') !== 'scrypt$131072$8$1' ||
    !/^[a-f0-9]{32}$/.test(parts[4] ?? '') ||
    !/^[a-f0-9]{128}$/.test(parts[5] ?? '')
  )
    return false;
  return timingSafeEqual(
    await derive(password, parts[4]!),
    Buffer.from(parts[5]!, 'hex'),
  );
}
