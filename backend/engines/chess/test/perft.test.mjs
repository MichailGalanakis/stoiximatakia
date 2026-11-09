import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assert, engine as e } from './helpers.mjs';
const fixtures = JSON.parse(
  readFileSync(new URL('./perft-fixtures.json', import.meta.url), 'utf8'),
);
for (const fixture of fixtures) {
  for (
    let depth = 0;
    depth <= Math.min(3, fixture.counts.length - 1);
    depth++
  ) {
    test(`perft ${fixture.name}, depth ${depth}: ${fixture.counts[depth]}`, () =>
      assert.equal(e.perft(fixture.fen, depth), fixture.counts[depth]));
  }
}
test('start position perft depth four = 197281', () =>
  assert.equal(e.perft(e.START_FEN, 4), 197281));
test('perft rejects unreasonable or invalid resource parameters', () => {
  for (const depth of [-1, 0.5, NaN, 7])
    assert.throws(() => e.perft(e.START_FEN, depth));
});
