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
