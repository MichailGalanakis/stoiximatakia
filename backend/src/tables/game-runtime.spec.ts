import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Test } from '@nestjs/testing';
import { GameRuntimeRegistry, type TableGameRuntime } from './game-runtime';

void it('Nest shutdown awaits an optional runtime close and closes a shared runtime only once', async () => {
  const registry = new GameRuntimeRegistry();
  let entered!: () => void,
    finish!: () => void,
    calls = 0;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    completed = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    runtime: TableGameRuntime = {
      start: () => ({ rulesVersion: 'test-only', state: {} }),
      close() {
        calls++;
        entered();
        return completed;
      },
    };
  registry.register('chess', runtime);
  registry.register('xeri', runtime);
  const module = await Test.createTestingModule({
    providers: [{ provide: GameRuntimeRegistry, useValue: registry }],
  }).compile();
  let stopped = false;
  const closing = module.close().then(() => {
    stopped = true;
  });
  await started;
  assert.equal(stopped, false);
  assert.equal(calls, 1);
  finish();
  await closing;
  await registry.onModuleDestroy();
  assert.equal(calls, 1);
  assert.throws(() => registry.register('tichu', runtime), /closed/);
});

void it('attempts all runtime cleanup even when one close rejects, while runtimes without close need no change', async () => {
  const registry = new GameRuntimeRegistry(),
    error = new Error('test cleanup failure');
  let cleaned = 0;
  registry.register('chess', {
    start: () => ({ rulesVersion: 'test', state: {} }),
    close: () => Promise.reject(error),
  });
  registry.register('xeri', {
    start: () => ({ rulesVersion: 'test', state: {} }),
    close() {
      cleaned++;
    },
  });
  registry.register('diloti', {
    start: () => ({ rulesVersion: 'test', state: {} }),
  });
  await assert.rejects(registry.onModuleDestroy(), error);
  assert.equal(cleaned, 1);
});
