import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maximumMatching } from '../dist/esm/matching.js';

// Independent oracle: enumerate every attainable occupied-square subset by
// considering each piece once. No augmenting paths or matching recursion.
// A piece may occupy zero or one target; captures can only remove capacity.
function occupancyOracle(targets, allowed) {
  let masks = new Set([0]);
  for (const region of allowed) {
    const next = new Set(masks);
    for (const mask of masks) {
      for (let bit = 0; bit < targets.length; bit++) {
        if (!(mask & (1 << bit)) && region.has(targets[bit]))
          next.add(mask | (1 << bit));
      }
    }
    masks = next;
  }
  let largest = 0;
  for (let mask of masks) {
    let count = 0;
    while (mask) {
      count += mask & 1;
      mask >>>= 1;
    }
    largest = Math.max(largest, count);
  }
  return largest;
}

test('escape occupancy capacity handles empty sides and ignores off-target squares', () => {
  assert.equal(maximumMatching([], []), 0);
  assert.equal(maximumMatching([0, 7], []), 0);
  assert.equal(maximumMatching([], [new Set([0, 7])]), 0);
  assert.equal(maximumMatching([0, 7], [new Set([63]), new Set()]), 0);
  assert.equal(
    maximumMatching([0, 7], [new Set([0, 23, 63]), new Set([7, 42])]),
    2,
  );
});

test('maximum occupancy repairs greedy choices through augmenting paths', () => {
  assert.equal(maximumMatching([0, 1], [new Set([0, 1]), new Set([0])]), 2);
  const chain = [
    new Set([0, 1]),
    new Set([1, 2]),
    new Set([2, 3]),
    new Set([0]),
  ];
  assert.equal(maximumMatching([0, 1, 2, 3], chain), 4);
  assert.equal(maximumMatching([3, 2, 1, 0], chain.slice().reverse()), 4);
});

test('equal-shaped regions remain separate piece identities', () => {
  const sameRegion = new Set([0, 7, 23]);
  assert.equal(maximumMatching([0, 7, 23], [sameRegion]), 1);
  assert.equal(maximumMatching([0, 7, 23], [sameRegion, sameRegion]), 2);
  assert.equal(
    maximumMatching([0, 7, 23], [sameRegion, sameRegion, sameRegion]),
    3,
  );
  assert.equal(
    maximumMatching(
      [0, 7, 23],
      [sameRegion, sameRegion, sameRegion, sameRegion],
    ),
    3,
  );
});

test('matching detects a deficient subset even when total piece count is sufficient', () => {
  // Every target has an occupant and there are three pieces, but the first
  // piece alone can cover either 0 or 7. The two others compete for square 23.
  const allowed = [new Set([0, 7]), new Set([23]), new Set([23])];
  assert.equal(maximumMatching([0, 7, 23], allowed), 2);
  assert.equal(occupancyOracle([0, 7, 23], allowed), 2);
});

test('matching agrees with exhaustive subset enumeration for every small bipartite graph', () => {
  const dimensions = [];
  for (let targets = 0; targets <= 3; targets++) {
    for (let pieces = 0; pieces <= 4; pieces++)
      dimensions.push([targets, pieces]);
  }
  dimensions.push([4, 3]);
  for (const [targetCount, pieceCount] of dimensions) {
    const targets = [0, 7, 23, 63].slice(0, targetCount);
    for (let graph = 0; graph < 2 ** (targetCount * pieceCount); graph++) {
      const allowed = Array.from({ length: pieceCount }, (_, piece) => {
        const region = new Set([48]); // irrelevant squares must not add capacity
        for (let target = 0; target < targetCount; target++) {
          if (graph & (1 << (piece * targetCount + target)))
            region.add(targets[target]);
        }
        return region;
      });
      assert.equal(
        maximumMatching(targets, allowed),
        occupancyOracle(targets, allowed),
        `targets=${targetCount}, pieces=${pieceCount}, graph=${graph}`,
      );
    }
  }
});

test('eight-square capacity agrees with a deterministic independent subset oracle', () => {
  let seed = 0x4f13a782;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const allTargets = [0, 2, 7, 17, 24, 39, 53, 63];
  for (let sample = 0; sample < 160; sample++) {
    const targets = allTargets.slice(0, (sample % 8) + 1);
    const allowed = Array.from({ length: random() % 25 }, () => {
      const region = new Set([15, 31]);
      const edges = random() >>> 16;
      for (let bit = 0; bit < targets.length; bit++)
        if (edges & (1 << bit)) region.add(targets[bit]);
      return region;
    });
    const originalTargets = targets.slice(),
      originalRegions = allowed.map((region) => [...region]);
    const expected = occupancyOracle(targets, allowed);
    assert.equal(
      maximumMatching(targets, allowed),
      expected,
      `sample ${sample}`,
    );
    assert.equal(
      maximumMatching(targets.slice().reverse(), allowed.slice().reverse()),
      expected,
      `reversed sample ${sample}`,
    );
    assert.deepEqual(targets, originalTargets);
    assert.deepEqual(
      allowed.map((region) => [...region]),
      originalRegions,
    );
  }
});
