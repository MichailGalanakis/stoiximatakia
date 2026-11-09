import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engine as e, assert, ok, start, move } from './helpers.mjs';
import { dispatch } from '../scripts/request.mjs';
const require = createRequire(import.meta.url);
const cjs = require('../dist/cjs/index.js');

test('CommonJS and ESM expose the same deterministic engine and compatible snapshots', () => {
  const state = start();
  const a = ok(e.applyAction(state, 'alice', move('e2', 'e4'), 0));
  const b = ok(cjs.applyAction(state, 'alice', move('e2', 'e4'), 0));
  assert.deepEqual(a, b);
  assert.deepEqual(ok(cjs.restoreState(JSON.stringify(a))), a);
  assert.deepEqual(Object.keys(e).sort(), Object.keys(cjs).sort());
});
test('the JSON-lines CLI emits one machine-readable response per input, including failures', () => {
  const input =
    [
      JSON.stringify({
        op: 'create',
        players: { white: 'alice', black: 'bob' },
      }),
      '{',
      JSON.stringify({ op: 'unknown' }),
      JSON.stringify({ op: 'create', players: { white: 'x', black: 'x' } }),
    ].join('\n') + '\n';
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/jsonl.mjs', import.meta.url))],
    { input, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const output = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(output.length, 4);
  assert.equal(output[0].ok, true);
  assert.equal(output[0].state.game, 'chess');
  assert.ok(output.slice(1).every((result) => !result.ok));
});
test('the local adapter routes only ordinary public operations, not adjudications', () => {
  const state = start();
  assert.equal(dispatch({ op: 'adjudicate', state }).ok, false);
  assert.equal(dispatch(null).ok, false);
  const next = ok(
    dispatch({
      op: 'apply',
      state,
      playerId: 'alice',
      action: move('e2', 'e4'),
      expectedRevision: 0,
    }),
  );
  assert.equal(next.ply, 1);
  assert.equal(
    ok(dispatch({ op: 'observe', state: next, viewer: 'bob' })).turn,
    'black',
  );
  assert.ok(
    ok(dispatch({ op: 'legal', state: next, playerId: 'bob' })).length > 0,
  );
  assert.equal(ok(dispatch({ op: 'validate', state: next })).valid, true);
  const snapshot = ok(dispatch({ op: 'serialize', state: next }));
  assert.deepEqual(ok(dispatch({ op: 'restore', snapshot })), next);
  assert.deepEqual(
    ok(
      dispatch({ op: 'replay', initial: next.initial, records: next.history }),
    ),
    next,
  );
  assert.equal(
    dispatch({ op: 'claims', state: next, playerId: 'bob' }).ok,
    true,
  );
});
test('the ready-built example runs without installing a runtime dependency', () => {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../examples/play.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.matchOutcome.gameReason, 'checkmate');
});
