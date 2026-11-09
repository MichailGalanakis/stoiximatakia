import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { perft } from '../dist/esm/index.js';
const fixtures = JSON.parse(
  readFileSync(new URL('../test/perft-fixtures.json', import.meta.url), 'utf8'),
);
let total = 0;
for (const fixture of fixtures) {
  const depth = fixture.counts.length - 1,
    expected = fixture.counts[depth],
    start = performance.now();
  const actual = perft(fixture.fen, depth);
  assert.equal(actual, expected, fixture.name);
  total += actual;
  console.log(
    JSON.stringify({
      test: fixture.name,
      depth,
      expected,
      actual,
      passed: true,
      milliseconds: Math.round(performance.now() - start),
    }),
  );
}
console.log(
  JSON.stringify({
    passed: true,
    fixtures: fixtures.length,
    leafNodesChecked: total,
  }),
);
