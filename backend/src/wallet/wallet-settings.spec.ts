import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxWithdrawableMinor, walletSettings } from './wallet-settings';

void test('withdrawals allow €100 in full, then 80% of the available balance', () => {
  const settings = walletSettings({});
  const cases: [number, number][] = [
    [0, 0],
    [5_000, 5_000],
    [10_000, 10_000],
    [11_000, 10_000],
    [12_500, 10_000],
    [12_501, 10_000],
    [15_000, 12_000],
    [20_000, 16_000],
    [100_001, 80_000],
  ];
  for (const [available, max] of cases)
    assert.equal(
      maxWithdrawableMinor(available, settings),
      max,
      `${available}`,
    );
});

void test('wallet settings reject an invalid withdrawal share', () => {
  assert.throws(() => walletSettings({ WALLET_WITHDRAWAL_SHARE_BPS: '10001' }));
  assert.equal(
    walletSettings({ WALLET_WITHDRAWAL_SHARE_BPS: '10000' }).withdrawalShareBps,
    10_000,
  );
});

void test('RF bank deposits and background jobs are configured from the environment', () => {
  const defaults = walletSettings({});
  assert.equal(defaults.rfIban, undefined);
  assert.equal(defaults.reconcileIntervalHours, 24);
  assert.equal(defaults.notifyIntervalSeconds, 60);
  const configured = walletSettings({
    WALLET_RF_IBAN: 'gr16 0110 1250 0000 0001 2300 695',
    WALLET_RECONCILE_INTERVAL_HOURS: '0',
  });
  assert.equal(configured.rfIban, 'GR1601101250000000012300695');
  assert.equal(configured.rfBeneficiary, 'SkillBetting');
  assert.equal(configured.reconcileIntervalHours, 0);
  assert.throws(() => walletSettings({ WALLET_RF_IBAN: 'not-an-iban' }));
});
