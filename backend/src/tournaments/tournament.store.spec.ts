import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prizeAmounts } from './tournament.store';

void test('prize amounts always sum to the pool, remainder to first place', () => {
  assert.deepEqual(prizeAmounts(2000, [6000, 3000, 1000]), [1200, 600, 200]);
  assert.deepEqual(prizeAmounts(999, [5000, 5000]), [500, 499]);
  assert.deepEqual(prizeAmounts(100, [3333, 3333, 3334]), [34, 33, 33]);
  // The PDF example: 100 players contributing €5 each.
  assert.deepEqual(prizeAmounts(50_000, [10_000]), [50_000]);
  const big = prizeAmounts(10_000 * 10_000_000, [7000, 2000, 1000]);
  assert.equal(
    big.reduce((a, b) => a + b, 0),
    10_000 * 10_000_000,
  );
});
