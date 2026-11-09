import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import { GAME_IDS, GAME_CONFIG, type GameId } from '../src/tables/game-catalog';
import { PlatformError } from '../src/tables/platform-error';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import {
  PlatformStore,
  type CommandResult,
} from '../src/tables/platform.store';

void describe('shared lifecycle and initial settlement against isolated PostgreSQL', () => {
  let admin: Pool, pool: Pool, app: NestFastifyApplication, url: string;
  const schema = 'match_' + randomUUID().replaceAll('-', ''),
    origin = 'https://match.skillbetting.invalid';
  async function application(version = 'controlled-match-test-v1') {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GameRuntimeRegistry)
      .useValue(new GameRuntimeRegistry())
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'controlled-match-secret'.repeat(3) })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      })
      .compile();
    const instance = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(instance, {
      log: () => {},
      warn: () => {},
      error: () => {},
    });
    for (const gameId of GAME_IDS)
      instance.get(GameRuntimeRegistry).register(gameId, {
        version,
        start: () => ({
          rulesVersion: 'controlled-test-rules',
          state: { moves: 0, round: 1 },
        }),
        apply: ({ state, userId, action, participants }) => {
          if (
            !action ||
            typeof action !== 'object' ||
            Array.isArray(action) ||
            Object.keys(action).some((k) => k !== 'kind') ||
            !('kind' in action) ||
            !['play', 'control', 'draw', 'win', 'round', 'bad-team'].includes(
              String(action.kind),
            )
          )
            throw new PlatformError('invalid_game_action', 400);
          const previous = state as { moves: number; round: number },
            kind = action.kind;
          const mine = participants.find((p) => p.userId === userId)!;
          const winners = participants
            .filter((p) =>
              GAME_CONFIG[gameId].team
                ? p.seat % 2 === mine.seat % 2
                : p.userId === userId,
            )
            .map((p) => p.userId);
          return {
            state: {
              moves:
                kind === 'round'
                  ? 0
                  : previous.moves + (kind === 'control' ? 0 : 1),
              round: previous.round + (kind === 'round' ? 1 : 0),
            },
            gameplay: kind !== 'control',
            ...(kind === 'draw'
              ? {
                  outcome: { kind: 'draw' as const, reason: 'controlled-draw' },
                }
              : {}),
            ...(kind === 'win' || kind === 'bad-team'
              ? {
                  outcome: {
                    kind: 'win' as const,
                    reason: 'controlled-win',
                    winnerUserIds:
                      kind === 'bad-team'
                        ? participants.slice(0, 2).map((p) => p.userId)
                        : winners,
                  },
                }
              : {}),
          };
        },
      });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    return instance;
  }
  before(async () => {
    const target = new URL(process.env.TEST_DATABASE_URL ?? '');
    assert.match(target.pathname, /_test$/);
    admin = new Pool({ connectionString: target.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    url = target.href;
    pool = new Pool({ connectionString: url });
    for (const f of (await readdir('migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort())
      await pool.query(await readFile('migrations/' + f, 'utf8'));
    app = await application();
  });
  after(async () => {
    await app?.close();
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
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at) VALUES($1,$2,$2,'test-only',$3,$4,'demo',null,null)`,
      [
        id,
        'M_' + id.replaceAll('-', '').slice(0, 20),
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
  const post = (p: Player, path: string, payload: unknown, target = app) =>
    target.inject({
      method: 'POST',
      url: '/multiplayer/v1/' + path,
      headers: {
        origin,
        'x-skillbetting-client': 'web-v1',
        cookie: p.cookie,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  async function balance(p: Player) {
    return (await app.get(PlatformStore).credits(p.hash)).balance;
  }
  async function started(
    gameId: GameId = 'chess',
    contribution = 500,
    privateCode?: string,
  ) {
    const players: Player[] = [];
    for (let i = 0; i < GAME_CONFIG[gameId].seats; i++)
      players.push(await player());
    const p = players[0]!;
    const created = await post(p, 'tables', {
      operationId: randomUUID(),
      gameId,
      name: 'Controlled settlement',
      visibility: privateCode ? 'private' : 'public',
      ...(privateCode ? { accessCode: privateCode } : {}),
      formatId: gameId === 'tichu' ? 'single' : 'standard',
      prizeContributionMinor: contribution,
    });
    assert.equal(created.statusCode, 201, created.body);
    const tableId = created.json<CommandResult>().table.id;
    for (let seat = 1; seat < players.length; seat++) {
      if (privateCode)
        assert.equal(
          (await post(players[seat]!, 'private-access', { code: privateCode }))
            .statusCode,
          201,
        );
      assert.equal(
        (
          await post(players[seat]!, `tables/${tableId}/seats`, {
            operationId: randomUUID(),
            seatIndex: seat,
          })
        ).statusCode,
        201,
      );
    }
    for (const p of players) {
      const r = await post(p, `tables/${tableId}/ready`, {
        operationId: randomUUID(),
      });
      assert.equal(r.statusCode, 201, r.body);
    }
    return { players, tableId, a: players[0]!, b: players[1]! };
  }
  const act = (
    p: Player,
    tableId: string,
    revision: number,
    kind: string,
    operationId = randomUUID(),
    target = app,
  ) =>
    target
      .get(PlatformStore)
      .applyGameAction(p.hash, tableId, operationId, revision, { kind });
  const rejects = (promise: Promise<unknown>, code: string) =>
    assert.rejects(
      promise,
      (e: unknown) => e instanceof PlatformError && e.code === code,
    );

  for (const lifecycle of ['completed', 'cancelled'] as const)
    void it(`${lifecycle}: keeps terminal public tables out of discovery while preserving tickets and direct links`, async () => {
      const store = app.get(PlatformStore),
        visitor = await player();
      const get = (p: Player, path: string) =>
        app.inject({
          method: 'GET',
          url: '/multiplayer/v1/' + path,
          headers: { cookie: p.cookie },
        });
      const createWaiting = async (extra: Record<string, unknown> = {}) => {
        const owner = await player();
        const response = await post(owner, 'tables', {
          operationId: randomUUID(),
          gameId: 'chess',
          name: 'Listing regression',
          visibility: 'public',
          formatId: 'standard',
          prizeContributionMinor: 500,
          ...extra,
        });
        assert.equal(response.statusCode, 201, response.body);
        return { owner, tableId: response.json<CommandResult>().table.id };
      };
      const waiting = await createWaiting(),
        full = await createWaiting(),
        withdrawn = await createWaiting(),
        remaining = await player(),
        second = await player();
      assert.equal(
        (
          await post(remaining, `tables/${withdrawn.tableId}/seats`, {
            operationId: randomUUID(),
            seatIndex: 1,
          })
        ).statusCode,
        201,
      );
      assert.equal(
        (
          await post(withdrawn.owner, `tables/${withdrawn.tableId}/cancel`, {
            operationId: randomUUID(),
          })
        ).statusCode,
        201,
      );
      // Individual withdrawal keeps a table open while someone remains seated.
      const withdrawnDirect = await store.get(
        withdrawn.owner.hash,
        withdrawn.tableId,
      );
      assert.equal(withdrawnDirect.table.status, 'waiting');
      assert.equal(withdrawnDirect.table.ticket?.state, 'cancelled');
      assert.equal(
        (
          await post(second, `tables/${full.tableId}/seats`, {
            operationId: randomUUID(),
            seatIndex: 1,
          })
        ).statusCode,
        201,
      );
      const playing = await started(),
        privateTable = await createWaiting({
          visibility: 'private',
          accessCode: 'List' + randomUUID().replaceAll('-', '').slice(0, 12),
        }),
        otherGame = await createWaiting({ gameId: 'xeri' });
      const terminal = await started();
      const ticketIds = new Map<string, string>();
      for (const p of terminal.players) {
        const direct = await store.get(p.hash, terminal.tableId);
        assert.ok(direct.table.ticket);
        ticketIds.set(p.id, direct.table.ticket.id);
      }
      const all = new Set([
        waiting.tableId,
        full.tableId,
        withdrawn.tableId,
        playing.tableId,
        privateTable.tableId,
        otherGame.tableId,
        terminal.tableId,
      ]);
      const listed = (tables: readonly { id: string }[]) =>
        tables
          .filter((t) => all.has(t.id))
          .map((t) => t.id)
          .sort();
      assert.deepEqual(
        listed((await store.list(visitor.hash, 'chess')).tables),
        [
          waiting.tableId,
          full.tableId,
          withdrawn.tableId,
          playing.tableId,
          terminal.tableId,
        ].sort(),
      );
      if (lifecycle === 'completed')
        await act(terminal.a, terminal.tableId, 1, 'win');
      else
        assert.equal(
          (
            await post(terminal.a, `tables/${terminal.tableId}/cancel`, {
              operationId: randomUUID(),
            })
          ).statusCode,
          201,
        );
      const status = lifecycle === 'completed' ? 'completed' : 'cancelled';
      const ticketState = lifecycle === 'completed' ? 'settled' : 'refunded';
      const balances = await Promise.all(terminal.players.map(balance));
      const response = await get(visitor, 'tables?gameId=chess');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const expected = [
        waiting.tableId,
        full.tableId,
        withdrawn.tableId,
        playing.tableId,
      ].sort();
      assert.deepEqual(
        listed(response.json<{ tables: { id: string }[] }>().tables),
        expected,
      );
      assert.deepEqual(
        listed((await store.liveSnapshot(visitor.hash, 'chess')).tables),
        expected,
      );
      const targeted = await store.liveSnapshot(
        terminal.a.hash,
        'chess',
        terminal.tableId,
      );
      assert.deepEqual(listed(targeted.tables), expected);
      assert.equal(targeted.table?.status, status);
      assert.equal(targeted.table?.ticket?.state, ticketState);
      const fullRead = await store.get(visitor.hash, full.tableId);
      assert.equal(fullRead.table.status, 'waiting');
      assert.equal(
        fullRead.table.seats.filter((s) => s.player).length,
        fullRead.table.capacity,
      );
      assert.equal(
        (await store.get(visitor.hash, playing.tableId)).table.status,
        'playing',
      );
      for (const p of terminal.players) {
        const tickets = await get(p, 'tickets');
        assert.equal(tickets.statusCode, 200, tickets.body);
        assert.equal(tickets.headers['cache-control'], 'no-store');
        const ticket = tickets
          .json<{
            tickets: {
              id: string;
              tableId: string;
              state: string;
              feeMinor: number;
              contributionMinor: number;
            }[];
          }>()
          .tickets.find((t) => t.tableId === terminal.tableId);
        assert.deepEqual(ticket, {
          id: ticketIds.get(p.id),
          tableId: terminal.tableId,
          state: ticketState,
          feeMinor: 90,
          contributionMinor: 500,
        });
        const direct = await get(p, `tables/${terminal.tableId}`);
        assert.equal(direct.statusCode, 200, direct.body);
        assert.equal(direct.json<CommandResult>().table.status, status);
        assert.equal(
          direct.json<CommandResult>().table.ticket?.id,
          ticketIds.get(p.id),
        );
      }
      const publicDirect = await get(visitor, `tables/${terminal.tableId}`);
      assert.equal(publicDirect.statusCode, 200, publicDirect.body);
      assert.equal(publicDirect.json<CommandResult>().table.status, status);
      assert.deepEqual(
        await Promise.all(terminal.players.map(balance)),
        balances,
      );
    });

  void it('keeps terminal public tables out of discovery when a match ends during snapshot loading', async () => {
    const { a, tableId } = await started(),
      visitor = await player(),
      store = app.get(PlatformStore);
    const original = store.snapshot.bind(store);
    let reached!: () => void, release!: () => void;
    const atSnapshot = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.snapshot = async (client, id, userId) => {
      if (id === tableId && userId === visitor.id) {
        reached();
        await proceed;
      }
      return original(client, id, userId);
    };
    const listing = store.list(visitor.hash, 'chess');
    try {
      await Promise.race([
        atSnapshot,
        listing.then(() =>
          assert.fail('The active match must be selected before it finishes'),
        ),
      ]);
      const finished = await act(a, tableId, 1, 'win');
      assert.equal(finished.table.status, 'completed');
      release();
      assert.equal(
        (await listing).tables.some((t) => t.id === tableId),
        false,
      );
    } finally {
      release();
      await listing.catch(() => {});
      store.snapshot = original;
    }
    assert.equal((await store.get(a.hash, tableId)).table.status, 'completed');
  });

  async function reconciled(tableId: string) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM credit_accounts a WHERE balance_minor<>(SELECT coalesce(sum(amount_minor),0) FROM credit_postings p WHERE p.account_key=a.key)`,
    );
    assert.equal(result.rows[0]!.n, 0);
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM table_participations WHERE table_id=$1',
          [tableId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_settlements WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      Number(
        (
          await pool.query<{ balance_minor: string }>(
            'SELECT balance_minor FROM credit_accounts WHERE key=$1',
            ['pool:' + tableId],
          )
        ).rows[0]!.balance_minor,
      ),
      0,
    );
  }

  void it('cancels a started zero-move match with all fees returned, once', async () => {
    const { a, b, tableId } = await started(),
      op = { operationId: randomUUID() };
    const r = await post(b, `tables/${tableId}/cancel`, op);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json<CommandResult>().match?.outcome?.kind, 'cancel');
    for (const p of [a, b])
      assert.deepEqual(await balance(p), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
    assert.deepEqual(
      (await post(b, `tables/${tableId}/cancel`, op)).json(),
      r.json(),
    );
    assert.equal(
      (await post(a, `tables/${tableId}/cancel`, { operationId: randomUUID() }))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM table_tickets WHERE table_id=$1 AND state='refunded'",
          [tableId],
        )
      ).rows[0]?.n,
      2,
    );
    await reconciled(tableId);
    assert.equal(
      (
        await post(a, 'tables', {
          operationId: randomUUID(),
          gameId: 'xeri',
          name: 'Next',
          visibility: 'public',
          formatId: 'standard',
          prizeContributionMinor: 100,
        })
      ).statusCode,
      201,
    );
  });
  void it('does not mistake control actions or rejected commands for accepted gameplay', async () => {
    const { a, tableId } = await started();
    await rejects(act(a, tableId, 1, 'illegal'), 'invalid_game_action');
    const control = await act(a, tableId, 1, 'control');
    assert.equal(control.match?.hasGameplay, false);
    assert.equal(control.match?.revision, 2);
    const r = await post(a, `tables/${tableId}/cancel`, {
      operationId: randomUUID(),
    });
    assert.equal(r.statusCode, 201, r.body);
    await reconciled(tableId);
  });
  void it('persists the gameplay marker across round changes, reconnect and restart', async () => {
    const { a, tableId } = await started();
    const op = randomUUID();
    const first = await act(a, tableId, 1, 'play', op);
    assert.equal(first.match?.hasGameplay, true);
    assert.deepEqual(await act(a, tableId, 1, 'play', op), first);
    await rejects(act(a, tableId, 1, 'draw', op), 'operation_conflict');
    await act(a, tableId, 2, 'round');
    const other = await application();
    try {
      const m = await other.get(PlatformStore).match(a.hash, tableId);
      assert.equal(m.match.hasGameplay, true);
      assert.equal(m.match.revision, 3);
      const cancel = await post(
        a,
        `tables/${tableId}/cancel`,
        { operationId: randomUUID() },
        other,
      );
      assert.equal(cancel.statusCode, 409);
      assert.equal(
        cancel.json<{ code: string }>().code,
        'cancellation_unavailable',
      );
      await rejects(
        act(a, tableId, 1, 'play', randomUUID(), other),
        'stale_game_revision',
      );
    } finally {
      await other.close();
    }
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM match_events WHERE table_id=$1 AND gameplay',
          [tableId],
        )
      ).rows[0]?.n,
      2,
    );
  });
  for (const gameId of GAME_IDS)
    void it(`settles an authoritative ${gameId} win using the whole winning side`, async () => {
      const { a, players, tableId } = await started(gameId);
      const op = randomUUID(),
        r = await act(a, tableId, 1, 'win', op);
      assert.equal(r.match?.outcome?.kind, 'win');
      assert.deepEqual(await act(a, tableId, 1, 'win', op), r);
      for (let i = 0; i < players.length; i++)
        assert.deepEqual(await balance(players[i]!), {
          availableMinor:
            24410 + ((players.length === 4 ? i % 2 === 0 : i === 0) ? 1000 : 0),
          reservedMinor: 0,
        });
      await rejects(act(players[1]!, tableId, 2, 'draw'), 'match_ended');
      await reconciled(tableId);
    });
  for (const contribution of [100, 500, 1500, 3000])
    void it(`returns only contributions on a draw at ${contribution} minor units`, async () => {
      const { a, b, tableId } = await started('chess', contribution);
      await act(a, tableId, 1, 'draw');
      for (const p of [a, b])
        assert.deepEqual(await balance(p), {
          availableMinor: 24910,
          reservedMinor: 0,
        });
      await reconciled(tableId);
    });
  void it('a deliberate forfeit pays the opponent and records its authenticated actor', async () => {
    const { a, b, tableId } = await started();
    await act(a, tableId, 1, 'play');
    const input = { operationId: randomUUID(), expectedRevision: 2 };
    const r = await post(a, `tables/${tableId}/forfeit`, input);
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual(
      (await post(a, `tables/${tableId}/forfeit`, input)).json(),
      r.json(),
    );
    assert.deepEqual(await balance(a), {
      availableMinor: 24410,
      reservedMinor: 0,
    });
    assert.deepEqual(await balance(b), {
      availableMinor: 25410,
      reservedMinor: 0,
    });
    const result = (
      await pool.query<{ actor_user_id: string; reason: string }>(
        'SELECT * FROM match_results WHERE table_id=$1',
        [tableId],
      )
    ).rows[0]!;
    assert.equal(result.actor_user_id, a.id);
    assert.equal(result.reason, 'explicit-forfeit');
    await reconciled(tableId);
  });
  void it('one forfeiting teammate loses for the entire partnership', async () => {
    const { players, tableId } = await started('tichu');
    const r = await post(players[2]!, `tables/${tableId}/forfeit`, {
      operationId: randomUUID(),
      expectedRevision: 1,
    });
    assert.equal(r.statusCode, 201, r.body);
    for (let i = 0; i < 4; i++)
      assert.equal(
        (await balance(players[i]!)).availableMinor,
        i % 2 === 1 ? 25410 : 24410,
      );
    await reconciled(tableId);
  });
  void it('rejects a forged or incomplete winning partnership without accepting its move', async () => {
    const { a, tableId } = await started('biriba');
    await rejects(act(a, tableId, 1, 'bad-team'), 'platform_unavailable');
    assert.equal(
      (await app.get(PlatformStore).match(a.hash, tableId)).match.revision,
      1,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      0,
    );
    await act(a, tableId, 1, 'win');
    await reconciled(tableId);
  });
  void it('only the trusted internal void operation refunds fees after gameplay', async () => {
    const { a, b, tableId } = await started();
    await act(a, tableId, 1, 'play');
    const input = {
      tableId,
      operationId: randomUUID(),
      expectedRevision: 2,
      reason: 'confirmed-rules-state-error' as const,
      evidenceReference: 'incident:isolated-rules-replay-failure',
    };
    const r = await app.get(PlatformStore).voidForBackendFailure(input);
    assert.deepEqual(
      await app.get(PlatformStore).voidForBackendFailure(input),
      r,
    );
    await rejects(
      app
        .get(PlatformStore)
        .voidForBackendFailure({ ...input, evidenceReference: 'different' }),
      'operation_conflict',
    );
    for (const p of [a, b])
      assert.deepEqual(await balance(p), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
    await reconciled(tableId);
    const read = await app.inject({
      method: 'GET',
      url: `/multiplayer/v1/tables/${tableId}/match`,
      headers: { cookie: a.cookie },
    });
    assert.equal(read.statusCode, 200);
    assert.doesNotMatch(read.body, /incident:|evidence|backend_operations/);
    assert.equal(
      (await post(a, `tables/${tableId}/void`, input)).statusCode,
      404,
    );
  });
  void it('requires exact revision and qualifying evidence for internal voids', async () => {
    const { tableId } = await started(),
      store = app.get(PlatformStore);
    const input = {
      tableId,
      operationId: randomUUID(),
      expectedRevision: 2,
      reason: 'unrecoverable-platform-failure' as const,
      evidenceReference: 'incident:state-corruption',
    };
    await rejects(store.voidForBackendFailure(input), 'stale_game_revision');
    await rejects(
      store.voidForBackendFailure({
        ...input,
        expectedRevision: 1,
        evidenceReference: '',
      }),
      'invalid_game_action',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM match_backend_operations WHERE operation_id=$1',
          [input.operationId],
        )
      ).rowCount,
      0,
    );
  });
  void it('serializes cancellation racing the first accepted move with one valid outcome', async () => {
    for (let i = 0; i < 30; i++) {
      const { a, b, tableId } = await started();
      const responses = await Promise.allSettled([
        act(a, tableId, 1, 'play'),
        app.get(PlatformStore).cancel(b.hash, tableId, randomUUID()),
      ]);
      assert.equal(responses.filter((r) => r.status === 'fulfilled').length, 1);
      for (const r of responses)
        if (r.status === 'rejected') {
          assert.ok(r.reason instanceof PlatformError);
          assert.ok(
            ['cancellation_unavailable', 'match_ended'].includes(r.reason.code),
            r.reason.code,
          );
        }
      const match = (await app.get(PlatformStore).match(a.hash, tableId)).match;
      if (match.outcome) {
        assert.equal(match.outcome.kind, 'cancel');
        assert.equal(match.hasGameplay, false);
        await reconciled(tableId);
      } else {
        assert.equal(match.hasGameplay, true);
        assert.equal((await balance(a)).availableMinor, 24410);
      }
    }
  });
  void it('two backend instances racing results cannot create two payouts', async () => {
    const { a, b, tableId } = await started(),
      other = await application();
    try {
      const results = await Promise.allSettled([
        act(a, tableId, 1, 'win'),
        other.get(PlatformStore).forfeit(b.hash, tableId, randomUUID(), 1),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      for (const r of results)
        if (r.status === 'rejected') {
          assert.ok(r.reason instanceof PlatformError);
          assert.equal(r.reason.code, 'match_ended');
        }
      await reconciled(tableId);
      assert.equal((await balance(a)).availableMinor, 25410);
      assert.equal((await balance(b)).availableMinor, 24410);
    } finally {
      await other.close();
    }
  });
  void it('rolls back result, gameplay, ledger, tickets and operation record together on failure', async () => {
    const { a, b, tableId } = await started(),
      op = randomUUID();
    await pool.query(
      `CREATE FUNCTION reject_match_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected settlement failure'; END; $$; CREATE TRIGGER reject_match_settlement BEFORE INSERT ON match_settlements FOR EACH ROW EXECUTE FUNCTION reject_match_settlement();`,
    );
    try {
      await rejects(act(a, tableId, 1, 'win', op), 'platform_unavailable');
    } finally {
      await pool.query(
        'DROP TRIGGER reject_match_settlement ON match_settlements; DROP FUNCTION reject_match_settlement()',
      );
    }
    assert.equal(
      (await app.get(PlatformStore).match(a.hash, tableId)).match.revision,
      1,
    );
    for (const p of [a, b])
      assert.equal((await balance(p)).availableMinor, 24410);
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM platform_operations WHERE operation_id=$1',
          [op],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      0,
    );
    await act(a, tableId, 1, 'win', op);
    await reconciled(tableId);
  });
  void it('keeps result and money history append-only and rejects a false history counter', async () => {
    const { a, tableId } = await started();
    await act(a, tableId, 1, 'draw');
    for (const sql of [
      "UPDATE match_results SET reason='overwritten'",
      'DELETE FROM match_events',
      'DELETE FROM match_settlements',
      'UPDATE match_allocations SET amount_minor=0',
      'DELETE FROM match_roster',
    ])
      await assert.rejects(pool.query(sql));
    const live = await started(),
      c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        'UPDATE table_games SET revision=revision+1,accepted_gameplay_count=1 WHERE table_id=$1',
        [live.tableId],
      );
      await assert.rejects(c.query('COMMIT'));
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    await reconciled(tableId);
  });
  void it('rejects spectators, foreign actors, invalid sessions, forged outcome fields and wrong origins', async () => {
    const { a, tableId } = await started(),
      visitor = await player();
    const r = await post(visitor, `tables/${tableId}/forfeit`, {
      operationId: randomUUID(),
      expectedRevision: 1,
    });
    assert.equal(r.statusCode, 403);
    const m = await app.inject({
      method: 'GET',
      url: `/multiplayer/v1/tables/${tableId}/match`,
      headers: { cookie: visitor.cookie },
    });
    assert.equal(m.statusCode, 403);
    const forged = await post(a, `tables/${tableId}/forfeit`, {
      operationId: randomUUID(),
      expectedRevision: 1,
      winnerUserIds: [a.id],
      refundMinor: 99999,
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/multiplayer/v1/tables/${tableId}/forfeit`,
          headers: { cookie: a.cookie },
          payload: { operationId: randomUUID(), expectedRevision: 1 },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/multiplayer/v1/tables/${tableId}/match`,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await post(a, `tables/${tableId}/result`, { winner: a.id })).statusCode,
      404,
    );
    assert.equal(
      (await post(a, `tables/${tableId}/action`, { kind: 'win' })).statusCode,
      404,
    );
  });
  void it('returns all four fees on an authorized void and restores retries across instances', async () => {
    const { a, players, tableId } = await started('biriba', 3000);
    await act(a, tableId, 1, 'play');
    const input = {
      tableId,
      operationId: randomUUID(),
      expectedRevision: 2,
      reason: 'unrecoverable-platform-failure' as const,
      evidenceReference: 'incident:controlled-four-player-state',
    };
    const first = await app.get(PlatformStore).voidForBackendFailure(input),
      other = await application();
    try {
      assert.deepEqual(
        await other.get(PlatformStore).voidForBackendFailure(input),
        first,
      );
    } finally {
      await other.close();
    }
    for (const p of players)
      assert.deepEqual(await balance(p), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
    assert.equal(
      (
        await pool.query<{ fee_returned_minor: number }>(
          'SELECT fee_returned_minor FROM match_settlements WHERE table_id=$1',
          [tableId],
        )
      ).rows[0]?.fee_returned_minor,
      360,
    );
    await reconciled(tableId);
  });
  void it('pins the initial state and refuses to run an upgraded adapter against old state', async () => {
    const { a, tableId } = await started();
    const root = (
      await pool.query<{
        payload: {
          initialState: unknown;
          engineVersion: string;
          rulesVersion: string;
        };
      }>('SELECT payload FROM match_events WHERE table_id=$1 AND revision=1', [
        tableId,
      ])
    ).rows[0]!.payload;
    assert.deepEqual(root.initialState, { moves: 0, round: 1 });
    assert.equal(root.engineVersion, 'controlled-match-test-v1');
    const other = await application('controlled-match-test-v2');
    try {
      await rejects(
        act(a, tableId, 1, 'play', randomUUID(), other),
        'engine_unavailable',
      );
    } finally {
      await other.close();
    }
    assert.equal(
      (await app.get(PlatformStore).match(a.hash, tableId)).match.revision,
      1,
    );
    await act(a, tableId, 1, 'draw');
    await reconciled(tableId);
  });

  void it('a partnership draw returns each contribution and retains each original fee', async () => {
    const { a, players, tableId } = await started('tichu', 1500);
    await act(a, tableId, 1, 'draw');
    for (const p of players)
      assert.equal((await balance(p)).availableMinor, 24910);
    await rejects(
      app.get(PlatformStore).voidForBackendFailure({
        tableId,
        operationId: randomUUID(),
        expectedRevision: 2,
        reason: 'confirmed-rules-state-error',
        evidenceReference: 'incident:requires-separate-paid-result-correction',
      }),
      'match_ended',
    );
    await reconciled(tableId);
  });
  void it('private-code access does not grant result or forfeit authority', async () => {
    const code = 'PrivateMatchCode',
      { a, tableId } = await started('chess', 500, code),
      visitor = await player();
    const granted = await post(visitor, 'private-access', { code });
    assert.equal(granted.statusCode, 201, granted.body);
    const read = await app.inject({
      method: 'GET',
      url: `/multiplayer/v1/tables/${tableId}/match`,
      headers: { cookie: visitor.cookie },
    });
    assert.equal(read.statusCode, 403);
    assert.equal(
      (
        await post(visitor, `tables/${tableId}/forfeit`, {
          operationId: randomUUID(),
          expectedRevision: 1,
        })
      ).statusCode,
      403,
    );
    await act(a, tableId, 1, 'win');
    const after = await app.inject({
      method: 'GET',
      url: `/multiplayer/v1/tables/${tableId}/match`,
      headers: { cookie: visitor.cookie },
    });
    assert.equal(after.statusCode, 403);
    await reconciled(tableId);
  });
  void it('a backend void racing an engine result settles exactly one authorized outcome', async () => {
    const { a, b, tableId } = await started(),
      store = app.get(PlatformStore);
    const results = await Promise.allSettled([
      act(a, tableId, 1, 'win'),
      store.voidForBackendFailure({
        tableId,
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: 'confirmed-rules-state-error',
        evidenceReference: 'incident:controlled-race',
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results)
      if (r.status === 'rejected') {
        assert.ok(r.reason instanceof PlatformError);
        assert.equal(r.reason.code, 'match_ended');
      }
    const outcome = (await store.match(a.hash, tableId)).match.outcome!;
    assert.equal(
      (await balance(a)).availableMinor,
      outcome.kind === 'void' ? 25000 : 25410,
    );
    assert.equal(
      (await balance(b)).availableMinor,
      outcome.kind === 'void' ? 25000 : 24410,
    );
    await reconciled(tableId);
  });
  void it('rolls back a payout if storing the final response fails, then retries exactly once', async () => {
    const { a, tableId } = await started(),
      op = randomUUID();
    await pool.query(
      `CREATE FUNCTION reject_match_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected final record failure'; END; $$; CREATE TRIGGER reject_match_operation BEFORE INSERT ON platform_operations FOR EACH ROW EXECUTE FUNCTION reject_match_operation();`,
    );
    try {
      await rejects(act(a, tableId, 1, 'win', op), 'platform_unavailable');
    } finally {
      await pool.query(
        'DROP TRIGGER reject_match_operation ON platform_operations; DROP FUNCTION reject_match_operation()',
      );
    }
    assert.equal(
      (await app.get(PlatformStore).match(a.hash, tableId)).match.revision,
      1,
    );
    assert.equal((await balance(a)).availableMinor, 24410);
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      0,
    );
    const first = await act(a, tableId, 1, 'win', op);
    assert.deepEqual(await act(a, tableId, 1, 'win', op), first);
    await reconciled(tableId);
  });
  void it('native websockets preserve disconnected players until an explicit forfeit commits', async () => {
    const { a, b, tableId } = await started();
    await app.listen(0, '127.0.0.1');
    async function connect(p: Player) {
      const socket = new WebSocket(
        (await app.getUrl()).replace('http:', 'ws:') + '/multiplayer/v1/live',
        { headers: { origin, cookie: p.cookie } },
      );
      const messages: Record<string, unknown>[] = [];
      socket.on('message', (data) => {
        assert.ok(Buffer.isBuffer(data));
        messages.push(
          JSON.parse(data.toString('utf8')) as Record<string, unknown>,
        );
      });
      await once(socket, 'open');
      async function wait(predicate: (m: Record<string, unknown>) => boolean) {
        for (let i = 0; i < 300; i++) {
          const found = messages.find(predicate);
          if (found) return found;
          await setTimeout(10);
        }
        assert.fail('No expected websocket response');
      }
      return { socket, messages, wait };
    }
    const left = await connect(a),
      right = await connect(b);
    let replacement: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      right.socket.send(
        JSON.stringify({
          id: randomUUID(),
          type: 'subscribe',
          gameId: 'chess',
          tableId,
        }),
      );
      await right.wait((m) => m.type === 'snapshot');
      left.socket.close();
      await once(left.socket, 'close');
      assert.equal(
        (
          await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
            tableId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM table_participations WHERE table_id=$1',
            [tableId],
          )
        ).rowCount,
        2,
      );
      replacement = await connect(a);
      const bad = randomUUID();
      replacement.socket.send(
        JSON.stringify({
          id: bad,
          type: 'forfeit',
          tableId,
          payload: {
            operationId: randomUUID(),
            expectedRevision: 1,
            winnerUserIds: [a.id],
          },
        }),
      );
      const rejected = await replacement.wait((m) => m.id === bad);
      assert.equal(rejected.type, 'error');
      const id = randomUUID();
      replacement.socket.send(
        JSON.stringify({
          id,
          type: 'forfeit',
          tableId,
          payload: { operationId: randomUUID(), expectedRevision: 1 },
        }),
      );
      const result = await replacement.wait((m) => m.id === id);
      assert.equal(result.type, 'result');
      const snapshot = await right.wait(
        (m) =>
          m.type === 'snapshot' &&
          !!m.table &&
          typeof m.table === 'object' &&
          'status' in m.table &&
          m.table.status === 'completed',
      );
      assert.deepEqual(snapshot.balance, {
        availableMinor: 25410,
        reservedMinor: 0,
      });
      await reconciled(tableId);
    } finally {
      left.socket.terminate();
      right.socket.terminate();
      replacement?.socket.terminate();
    }
  });

  void it('session revocation and navigation do not infer forfeit, result or refunds', async () => {
    const { a, tableId } = await started();
    await act(a, tableId, 1, 'play');
    await pool.query('DELETE FROM account_sessions WHERE token_hash=$1', [
      a.hash,
    ]);
    await rejects(
      app.get(PlatformStore).forfeit(a.hash, tableId, randomUUID(), 2),
      'account_session_expired',
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_results WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM table_participations WHERE table_id=$1',
          [tableId],
        )
      ).rowCount,
      2,
    );
    assert.equal(
      (
        await pool.query<{ revision: number }>(
          'SELECT revision FROM table_games WHERE table_id=$1',
          [tableId],
        )
      ).rows[0]?.revision,
      2,
    );
  });
});
