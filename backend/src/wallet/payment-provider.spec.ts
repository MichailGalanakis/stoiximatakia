import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BankRfProvider, rfCode, validRfCode } from './payment-provider';

void test('RF codes follow ISO 11649', () => {
  // Example reference from the standard.
  assert.equal(rfCode('539007547034'), 'RF18539007547034');
  assert.equal(validRfCode('RF18539007547034'), true);
  assert.equal(validRfCode('RF19539007547034'), false);
  assert.equal(validRfCode('RF18539007547035'), false);
  assert.throws(() => rfCode('too-long-reference-0000'));
});

void test('each RF deposit gets a valid code and transfer instructions', async () => {
  const provider = new BankRfProvider(
    'GR1601101250000000012300695',
    'SkillBetting',
  );
  const deposit = await provider.createDeposit({
    depositId: '0b6e4f12-3456-4789-8abc-def012345678',
  });
  assert.equal(validRfCode(deposit.providerReference), true);
  assert.deepEqual(deposit.instructions, {
    rfCode: deposit.providerReference,
    iban: 'GR1601101250000000012300695',
    beneficiary: 'SkillBetting',
  });
});
