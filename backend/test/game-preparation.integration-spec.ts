import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { before, after, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import {
  GameRuntimeRegistry,
  type GameActionInput,
  type GameActionTransition,
  type GameStartInput,
  type GameInitialization,
  type TableGameRuntime,
} from '../src/tables/game-runtime';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import {
  PlatformStore,
  type CommandResult,
} from '../src/tables/platform.store';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function preparationGate() {
  type Job = {
    input: GameActionInput;
    result: ReturnType<typeof deferred<GameActionTransition>>;
  };
  const jobs: Job[] = [],
    waiting: ReturnType<typeof deferred<Job>>[] = [];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    prepare: (input: GameActionInput) => {
      calls++;
      const job = { input, result: deferred<GameActionTransition>() };
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(job);
      else jobs.push(job);
      return job.result.promise;
    },
    next(): Promise<Job> {
      const job = jobs.shift();
      if (job) return Promise.resolve(job);
      const waiter = deferred<Job>();
      waiting.push(waiter);
      return waiter.promise;
    },
  };
}
function startGate() {
  type Job = {
    input: GameStartInput;
    result: ReturnType<typeof deferred<GameInitialization>>;
  };
  const jobs: Job[] = [],
    waiting: ReturnType<typeof deferred<Job>>[] = [];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    prepare: (input: GameStartInput) => {
      calls++;
      const job = { input, result: deferred<GameInitialization>() },
        waiter = waiting.shift();
      if (waiter) waiter.resolve(job);
      else jobs.push(job);
      return job.result.promise;
    },
    next(): Promise<Job> {
      const job = jobs.shift();
      if (job) return Promise.resolve(job);
      const waiter = deferred<Job>();
      waiting.push(waiter);
      return waiter.promise;
    },
  };
}
const initial = (): GameInitialization => ({
  rulesVersion: 'controlled-preparation-rules',
  state: { moves: 0 },
});

function transition(input: GameActionInput): GameActionTransition {
  const state = input.state as { moves: number },
    action = input.action as { kind: string };
  return {
    state: { moves: state.moves + 1 },
    gameplay: true,
    ...(action.kind === 'win'
      ? {
          outcome: {
            kind: 'win' as const,
            winnerUserIds: [input.userId],
            reason: 'controlled-win',
          },
        }
      : {}),
  };
}

void describe('off-transaction game preparation against isolated PostgreSQL', () => {
  let admin: Pool, pool: Pool, url: string;
  const schema = 'prepare_' + randomUUID().replaceAll('-', ''),
    origin = 'https://prepare.skillbetting.invalid',
    apps = new Set<NestFastifyApplication>();
  async function application(
    prepare?: TableGameRuntime['prepare'],
    prepareStart?: TableGameRuntime['prepareStart'],
  ) {
    const runtime = {
      version: 'controlled-preparation-v1',
      start: () => ({
        rulesVersion: 'controlled-preparation-rules',
        state: { moves: 0 },
      }),
      apply: transition,
      observe: ({ state, userId }: { state: unknown; userId: string }) => ({
        ...(state as { moves: number }),
        viewer: userId,
      }),
      ...(prepare ? { prepare } : {}),
      ...(prepareStart ? { prepareStart } : {}),
    };
    const registry = new GameRuntimeRegistry();
    registry.register('chess', runtime);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GameRuntimeRegistry)
      .useValue(registry)
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'preparation-isolated-secret'.repeat(3) })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      })
      .compile();
    const app = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(app, { log() {}, warn() {}, error() {} });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.add(app);
    return { app, runtime, registry, store: app.get(PlatformStore) };
  }
  before(async () => {
    const target = new URL(process.env.TEST_DATABASE_URL ?? '');
    assert.match(target.pathname, /_test$/);
    admin = new Pool({ connectionString: target.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    url = target.href;
    pool = new Pool({ connectionString: url });
    for (const file of (await readdir('migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort())
      await pool.query(await readFile('migrations/' + file, 'utf8'));
  });
  after(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function player() {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex'),
      hash = tokenDigest(token);
    await pool.query(
      "INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at) VALUES($1,$2,$2,'isolated-test',$3,$4,'demo',null,null)",
      [
        id,
        'P_' + id.replaceAll('-', '').slice(0, 20),
        id + '@demo.invalid',
        'demo:' + id,
      ],
    );
    await pool.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [hash, id],
    );
    return { id, hash, cookie: '__Host-sb_session=' + token };
  }
  type Player = Awaited<ReturnType<typeof player>>;
  const post = (
    app: NestFastifyApplication,
    p: Player,
    path: string,
    payload: unknown,
  ) =>
    app.inject({
      method: 'POST',
      url: '/multiplayer/v1/' + path,
      headers: {
        cookie: p.cookie,
        origin,
        'x-skillbetting-client': 'web-v1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  async function waitingTable(app: NestFastifyApplication) {
    const players = await Promise.all([player(), player()]),
      [a, b] = players,
      response = await post(app, a, 'tables', {
        operationId: randomUUID(),
        gameId: 'chess',
        name: 'Off-lock preparation',
        visibility: 'public',
        formatId: 'standard',
        prizeContributionMinor: 100,
      });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json<CommandResult>().table.id;
    assert.equal(
      (
        await post(app, b, `tables/${id}/seats`, {
          operationId: randomUUID(),
          seatIndex: 1,
        })
      ).statusCode,
      201,
    );
    return { players, a, b, id };
  }
  async function started(app: NestFastifyApplication) {
    const table = await waitingTable(app);
    for (const p of table.players)
      assert.equal(
        (
          await post(app, p, `tables/${table.id}/ready`, {
            operationId: randomUUID(),
          })
        ).statusCode,
        201,
      );
    return table;
  }
  async function durable(id: string) {
    return {
      game: (
        await pool.query('SELECT * FROM table_games WHERE table_id=$1', [id])
      ).rows,
      events: (
        await pool.query(
          'SELECT * FROM match_events WHERE table_id=$1 ORDER BY revision',
          [id],
        )
      ).rows,
      results: (
        await pool.query('SELECT * FROM match_results WHERE table_id=$1', [id])
      ).rows,
      settlements: (
        await pool.query('SELECT * FROM match_settlements WHERE table_id=$1', [
          id,
        ])
      ).rows,
      operations: (
        await pool.query(
          'SELECT * FROM platform_operations ORDER BY user_id,operation_id',
        )
      ).rows,
      credits: (
        await pool.query(
          'SELECT key,balance_minor FROM credit_accounts ORDER BY key',
        )
      ).rows,
      postings: (
        await pool.query(
          'SELECT * FROM credit_postings ORDER BY journal_id,account_key',
        )
      ).rows,
    };
  }
  const action = (
    store: PlatformStore,
    p: Player,
    id: string,
    kind = 'play',
    operation = randomUUID(),
  ) => store.applyGameAction(p.hash, id, operation, 1, { kind });

  void it('holds no account/session/table/game lock during preparation and detaches the normalized input and prepared output', async () => {
    const gate = preparationGate(),
      { app, store } = await application(gate.prepare),
      { a, id } = await started(app),
      operation = randomUUID(),
      input = { kind: 'play' },
      pending = store.applyGameAction(a.hash, id, operation, 1, input),
      job = await gate.next();
    for (const value of [
      job.input,
      job.input.action,
      job.input.state,
      job.input.participants,
      job.input.participants[0],
    ])
      assert.equal(Object.isFrozen(value), true);
    assert.throws(() => {
      (job.input.state as { moves: number }).moves = 900;
    }, TypeError);
    input.kind = 'win';
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE NOWAIT', [
        a.id,
      ]);
      await blocker.query(
        'SELECT 1 FROM account_sessions WHERE token_hash=$1 FOR UPDATE NOWAIT',
        [a.hash],
      );
      await blocker.query(
        'SELECT 1 FROM game_tables WHERE id=$1 FOR UPDATE NOWAIT',
        [id],
      );
      await blocker.query(
        'SELECT 1 FROM table_games WHERE table_id=$1 FOR UPDATE NOWAIT',
        [id],
      );
      const accepted = transition(job.input);
      job.result.resolve(accepted);
      await setImmediate();
      (accepted.state as { moves: number }).moves = 900;
      accepted.gameplay = false;
      accepted.outcome = {
        kind: 'win',
        winnerUserIds: [a.id],
        reason: 'mutated-after-return',
      };
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const result = await pending;
    assert.equal(result.game?.revision, 2);
    assert.equal((result.game?.observation as { moves: number }).moves, 1);
    assert.equal(result.match?.hasGameplay, true);
    assert.equal(result.match?.outcome, null);
    assert.deepEqual(
      await store.applyGameAction(a.hash, id, operation, 1, { kind: 'play' }),
      result,
    );
    await assert.rejects(
      store.applyGameAction(a.hash, id, operation, 1, input),
      { code: 'operation_conflict' },
    );
    assert.equal(gate.calls, 1);
  });

  void it('reauthenticates after proof and rejects a revoked session without writing any game/operation/credit effect', async () => {
    const gate = preparationGate(),
      { app, store } = await application(gate.prepare),
      { a, id } = await started(app),
      pending = action(store, a, id, 'win'),
      rejected = assert.rejects(pending, { code: 'account_session_expired' }),
      job = await gate.next();
    // A real logout deletes this same session row; it must not wait for proof.
    await pool.query('DELETE FROM account_sessions WHERE token_hash=$1', [
      a.hash,
    ]);
    const before = await durable(id);
    job.result.resolve(transition(job.input));
    await rejected;
    assert.deepEqual(await durable(id), before);
  });

  for (const terminal of ['cancel', 'forfeit'] as const)
    void it(`allows concurrent ${terminal} while proof runs and discards its stale winning result with no duplicate payout`, async () => {
      const gate = preparationGate(),
        { app, store } = await application(gate.prepare),
        { a, b, id } = await started(app),
        pending = action(store, a, id, 'win'),
        rejected = assert.rejects(pending, { code: 'match_ended' }),
        job = await gate.next(),
        response = await post(
          app,
          terminal === 'forfeit' ? a : b,
          `tables/${id}/${terminal}`,
          {
            operationId: randomUUID(),
            ...(terminal === 'forfeit' ? { expectedRevision: 1 } : {}),
          },
        );
      assert.equal(response.statusCode, 201, response.body);
      if (terminal === 'forfeit')
        assert.deepEqual(
          response.json<CommandResult>().match?.outcome?.winnerUserIds,
          [b.id],
        );
      const before = await durable(id);
      job.result.resolve(transition(job.input));
      await rejected;
      assert.deepEqual(await durable(id), before);
    });

  void it('lets another prepared move commit and rejects the older computation by authoritative revision without extra writes', async () => {
    const gate = preparationGate(),
      { app, store } = await application(gate.prepare),
      { a, b, id } = await started(app),
      pending = action(store, a, id, 'win'),
      rejected = assert.rejects(pending, { code: 'stale_game_revision' }),
      first = await gate.next(),
      competing = action(store, b, id),
      second = await gate.next();
    second.result.resolve(transition(second.input));
    assert.equal((await competing).game?.revision, 2);
    const before = await durable(id);
    first.result.resolve(transition(first.input));
    await rejected;
    assert.deepEqual(await durable(id), before);
  });

  void it('returns a concurrent same-operation success even if the losing preparation later throws, including terminal exact retries', async () => {
    const gate = preparationGate(),
      { app, store } = await application(gate.prepare),
      { a, id } = await started(app),
      operation = randomUUID(),
      first = action(store, a, id, 'win', operation),
      firstJob = await gate.next(),
      duplicate = action(store, a, id, 'win', operation),
      secondJob = await gate.next();
    firstJob.result.resolve(transition(firstJob.input));
    const result = await first,
      before = await durable(id);
    assert.deepEqual(result.match?.outcome?.winnerUserIds, [a.id]);
    secondJob.result.reject(
      new Error('Worker failed after the other request committed'),
    );
    assert.deepEqual(await duplicate, result);
    assert.deepEqual(await action(store, a, id, 'win', operation), result);
    assert.equal(gate.calls, 2);
    assert.deepEqual(await durable(id), before);
  });

  for (const changed of ['version', 'hook', 'table revision'] as const)
    void it(`binds preparation to the original ${changed} even when the requested game revision has not changed`, async () => {
      const gate = preparationGate(),
        { app, store, runtime } = await application(gate.prepare),
        { a, id } = await started(app),
        pending = action(store, a, id, 'win'),
        rejected = assert.rejects(pending, {
          code:
            changed === 'table revision'
              ? 'stale_game_revision'
              : 'engine_unavailable',
        }),
        job = await gate.next();
      if (changed === 'version') runtime.version = 'replacement-version';
      if (changed === 'hook')
        runtime.prepare = (input) => Promise.resolve(transition(input));
      if (changed === 'table revision')
        await pool.query(
          'UPDATE game_tables SET revision=revision+1 WHERE id=$1',
          [id],
        );
      const before = await durable(id);
      job.result.resolve(transition(job.input));
      await rejected;
      assert.deepEqual(await durable(id), before);
    });

  void it('rejects invalid prepared envelopes atomically and never calls synchronous apply as an unresolved fallback', async () => {
    const gate = preparationGate(),
      { app, store, runtime } = await application(gate.prepare),
      { a, id } = await started(app),
      pending = action(store, a, id),
      rejected = assert.rejects(pending, { code: 'platform_unavailable' }),
      job = await gate.next(),
      before = await durable(id);
    runtime.apply = () => {
      throw new Error('Synchronous fallback must not run');
    };
    job.result.resolve({
      state: { moves: 1 },
      gameplay: 'invalid' as unknown as boolean,
    });
    await rejected;
    assert.deepEqual(await durable(id), before);
  });

  void it('keeps the synchronous runtime path to one original session transaction when no hook exists', async () => {
    const { app, store, registry } = await application(),
      { a, id } = await started(app);
    assert.equal(registry.hasPreparation(), false);
    const original = store.session.bind(store);
    let transactions = 0;
    store.session = async (hash, run) => {
      transactions++;
      return original(hash, run);
    };
    const result = await action(store, a, id);
    assert.equal(result.game?.revision, 2);
    assert.equal(transactions, 1);
  });

  void it('rejects explicit malformed prepared outcomes instead of silently treating them as nonterminal moves', async () => {
    const gate = preparationGate(),
      { app, store } = await application(gate.prepare),
      { a, id } = await started(app),
      before = await durable(id);
    for (const outcome of [null, false, 0, [], { kind: 'draw', reason: 7 }]) {
      const pending = action(store, a, id),
        rejected = assert.rejects(pending, { code: 'platform_unavailable' }),
        job = await gate.next();
      job.result.resolve({
        state: { moves: 1 },
        gameplay: true,
        outcome,
      } as unknown as GameActionTransition);
      await rejected;
      assert.deepEqual(await durable(id), before);
    }
  });

  void it('prepares startup without account/session/table/ticket locks and permits concurrent readiness without duplicate funding', async () => {
    const gate = startGate(),
      { app, store, runtime } = await application(undefined, gate.prepare),
      { a, b, id } = await waitingTable(app),
      operation = randomUUID(),
      first = store.ready(a.hash, id, operation),
      one = await gate.next();
    runtime.start = () => {
      throw new Error('Synchronous initialization must not run');
    };
    for (const value of [
      one.input,
      one.input.participants,
      one.input.participants[0],
    ])
      assert.equal(Object.isFrozen(value), true);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE NOWAIT', [
        a.id,
      ]);
      await blocker.query(
        'SELECT 1 FROM account_sessions WHERE token_hash=$1 FOR UPDATE NOWAIT',
        [a.hash],
      );
      await blocker.query(
        'SELECT 1 FROM game_tables WHERE id=$1 FOR UPDATE NOWAIT',
        [id],
      );
      await blocker.query(
        'SELECT 1 FROM table_tickets WHERE table_id=$1 FOR UPDATE NOWAIT',
        [id],
      );
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const second = store.ready(b.hash, id, randomUUID()),
      two = await gate.next();
    two.result.resolve(initial());
    assert.equal((await second).table.status, 'waiting');
    const accepted = initial();
    one.result.resolve(accepted);
    await setImmediate();
    (accepted.state as { moves: number }).moves = 900;
    const result = await first;
    assert.equal(result.table.status, 'playing');
    assert.equal((result.game?.observation as { moves: number }).moves, 0);
    assert.deepEqual(await store.ready(a.hash, id, operation), result);
    assert.equal(gate.calls, 2);
    assert.equal(
      (await pool.query('SELECT 1 FROM match_events WHERE table_id=$1', [id]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM credit_journals WHERE operation_key=$1',
          ['start:' + id],
        )
      ).rowCount,
      1,
    );
  });

  void it('returns a concurrent startup receipt when the losing worker fails after the table was funded', async () => {
    const gate = startGate(),
      { app, store } = await application(undefined, gate.prepare),
      { a, b, id } = await waitingTable(app),
      readyA = store.ready(a.hash, id, randomUUID());
    (await gate.next()).result.resolve(initial());
    await readyA;
    const operation = randomUUID(),
      first = store.ready(b.hash, id, operation),
      one = await gate.next(),
      duplicate = store.ready(b.hash, id, operation),
      two = await gate.next();
    one.result.resolve(initial());
    const result = await first,
      before = await durable(id);
    two.result.reject(
      new Error('Worker failed after concurrent committed startup'),
    );
    assert.deepEqual(await duplicate, result);
    assert.deepEqual(await store.ready(b.hash, id, operation), result);
    assert.deepEqual(await durable(id), before);
  });

  void it('discards initial proof for replaced reservations even when the same table becomes ready again', async () => {
    const gate = startGate(),
      { app, store } = await application(undefined, gate.prepare),
      { a, b, id } = await waitingTable(app),
      readyA = store.ready(a.hash, id, randomUUID());
    (await gate.next()).result.resolve(initial());
    await readyA;
    const pending = store.ready(b.hash, id, randomUUID()),
      rejected = assert.rejects(pending, { code: 'table_unavailable' }),
      old = await gate.next();
    assert.equal(
      (await post(app, a, `tables/${id}/cancel`, { operationId: randomUUID() }))
        .statusCode,
      201,
    );
    const replacement = await player();
    assert.equal(
      (
        await post(app, replacement, `tables/${id}/seats`, {
          operationId: randomUUID(),
          seatIndex: 0,
        })
      ).statusCode,
      201,
    );
    const readyReplacement = store.ready(replacement.hash, id, randomUUID());
    (await gate.next()).result.resolve(initial());
    await readyReplacement;
    const before = await durable(id);
    old.result.resolve(initial());
    await rejected;
    assert.deepEqual(await durable(id), before);
    assert.equal(
      (await pool.query('SELECT 1 FROM table_games WHERE table_id=$1', [id]))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query<{ ready: boolean }>(
          'SELECT ready FROM table_participations WHERE user_id=$1',
          [b.id],
        )
      ).rows[0]?.ready,
      false,
    );
  });

  for (const changed of ['session', 'version', 'hook', 'envelope'] as const)
    void it(`rejects ${changed} changes before prepared startup commits any funding`, async () => {
      const gate = startGate(),
        { app, store, runtime } = await application(undefined, gate.prepare),
        { a, b, id } = await waitingTable(app),
        readyA = store.ready(a.hash, id, randomUUID());
      (await gate.next()).result.resolve(initial());
      await readyA;
      const pending = store.ready(b.hash, id, randomUUID()),
        rejected = assert.rejects(pending, {
          code:
            changed === 'session'
              ? 'account_session_expired'
              : changed === 'envelope'
                ? 'platform_unavailable'
                : 'engine_unavailable',
        }),
        job = await gate.next();
      if (changed === 'session')
        await pool.query('DELETE FROM account_sessions WHERE token_hash=$1', [
          b.hash,
        ]);
      if (changed === 'version') runtime.version = 'replaced';
      if (changed === 'hook')
        runtime.prepareStart = () => Promise.resolve(initial());
      const before = await durable(id);
      job.result.resolve(
        changed === 'envelope' ? { rulesVersion: '', state: {} } : initial(),
      );
      await rejected;
      assert.deepEqual(await durable(id), before);
      assert.equal(
        (
          await pool.query<{ ready: boolean }>(
            'SELECT ready FROM table_participations WHERE user_id=$1',
            [b.id],
          )
        ).rows[0]?.ready,
        false,
      );
    });
});
