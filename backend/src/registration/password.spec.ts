import assert from 'node:assert/strict';
import { it } from 'node:test';
import { hashPassword, verifyPassword } from './password';

void it('salts passwords and verifies exact values without truncation', async () => {
  const password = 'A real test passphrase 🔒';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password + 'x', first), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
});
