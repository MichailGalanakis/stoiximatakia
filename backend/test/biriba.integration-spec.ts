import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { before, after, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import * as rummy from '#engines/rummy';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import { BiribaGameRuntime } from '../src/tables/card-game-runtime';
import type { TableSnapshot } from '../src/tables/platform.store';
import type { MatchSummary } from '../src/tables/match-lifecycle';
import { biribaMove } from './biriba-play';

interface Room {
  table: TableSnapshot;
  game: {
    status: string;
    revision: number;
    engineVersion: string;
    rulesVersion: string;
    observation: rummy.RummyObservation;
  };
  match: MatchSummary;
  balance: { availableMinor: number; reservedMinor: number };
}
void describe('four-player Biriba against PostgreSQL', () => {
  let admin: Pool, pool: Pool, app: NestFastifyApplication, url: string;
  const schema = 'biriba_' + randomUUID().replaceAll('-', ''),
    origin = 'https://biriba.skillbetting.invalid';
  const sockets = new Set<WebSocket>();
  async function application(seed?: string) {
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'biriba-isolated-code-secret'.repeat(3) })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      });
    if (seed) {
      // Reproducible server-owned seed; this still creates a standard, replayable game.
      // No scripted decks, altered scores or analysis state enter funded matches.
      const engine = new BiribaGameRuntime(),
        registry = new GameRuntimeRegistry();
      registry.register('biriba', {
        version: engine.version,
        start(input) {
          const validated = engine.start(input),
            created = rummy.createGame({
              game: 'biriba',
              players: validated.state.initial.players,
              seed,
            });
          assert.ok(created.ok);
          return { rulesVersion: validated.rulesVersion, state: created.state };
        },
        apply: (input) => engine.apply(input),
        observe: (input) => engine.observe(input),
        preview: (input) => engine.preview(input),
      });
      builder.overrideProvider(GameRuntimeRegistry).useValue(registry);
    }
    const module = await builder.compile();
    const instance = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(instance, { log() {}, warn() {}, error() {} });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    await instance.listen(0, '127.0.0.1');
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
    for (const file of (await readdir('migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort())
      await pool.query(await readFile('migrations/' + file, 'utf8'));
    app = await application();
  });
  after(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function player() {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at) VALUES($1,$2,$2,'isolated-test',$3,$4,'demo',null,null)",
      [
        id,
        'B_' + id.replaceAll('-', '').slice(0, 20),
        id + '@demo.invalid',
        'demo:' + id,
      ],
    );
    await pool.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [tokenDigest(token), id],
    );
    return { id, token, cookie: '__Host-sb_session=' + token };
  }
  type Player = Awaited<ReturnType<typeof player>>;
  const post = (p: Player, path: string, payload: unknown, target = app) =>
    target.inject({
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
  const get = (p: Player, path: string, target = app) =>
    target.inject({
      method: 'GET',
      url: '/multiplayer/v1/' + path,
      headers: { cookie: p.cookie },
    });
  const credits = async (p: Player) =>
    (await get(p, 'credits')).json<{ balance: Room['balance'] }>().balance;
  async function table(target = app, privateCode?: string) {
    const players = await Promise.all([player(), player(), player(), player()]);
    const response = await post(
      players[0],
      'tables',
      {
        operationId: randomUUID(),
        gameId: 'biriba',
        name: 'Biriba integration',
        visibility: privateCode ? 'private' : 'public',
        ...(privateCode ? { accessCode: privateCode } : {}),
        formatId: 'standard',
        prizeContributionMinor: 100,
      },
      target,
    );
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json<Room>().table.id;
    for (let seat = 1; seat < 4; seat++) {
      if (privateCode)
        assert.equal(
          (
            await post(
              players[seat]!,
              'private-access',
              { code: privateCode },
              target,
            )
          ).statusCode,
          201,
        );
      const joined = await post(
        players[seat]!,
        `tables/${id}/seats`,
        { operationId: randomUUID(), seatIndex: seat },
        target,
      );
      assert.equal(joined.statusCode, 201, joined.body);
    }
    return { players, id };
  }
  async function started(target = app, code?: string) {
    const created = await table(target, code);
    for (const p of created.players) {
      const ready = await post(
        p,
        `tables/${created.id}/ready`,
        { operationId: randomUUID() },
        target,
      );
      assert.equal(ready.statusCode, 201, ready.body);
    }
    return created;
  }
  async function room(p: Player, id: string, target = app) {
    const response = await get(p, `tables/${id}`, target);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Room>();
  }
  const move = (
    p: Player,
    id: string,
    current: Room,
    action: unknown,
    operationId: string = randomUUID(),
    target = app,
  ) =>
    post(
      p,
      `tables/${id}/actions`,
      { operationId, expectedRevision: current.game.revision, action },
      target,
    );
  const stored = async (id: string) =>
    (
      await pool.query<{ state: rummy.RummyState; revision: number }>(
        'SELECT state,revision FROM table_games WHERE table_id=$1',
        [id],
      )
    ).rows[0]!;
  async function reconciled(id: string) {
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM credit_accounts a WHERE balance_minor<>(SELECT coalesce(sum(amount_minor),0) FROM credit_postings p WHERE p.account_key=a.key)',
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_settlements WHERE table_id=$1', [
          id,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM table_participations WHERE table_id=$1',
          [id],
        )
      ).rowCount,
      0,
    );
  }

  void it('waits for all four funded seats and ready actions, then projects distinct private hands including from partners', async () => {
    const { players, id } = await table();
    for (const p of players.slice(0, 3))
      assert.equal(
        (await post(p, `tables/${id}/ready`, { operationId: randomUUID() }))
          .statusCode,
        201,
      );
    assert.equal((await room(players[0], id)).table.status, 'waiting');
    for (const p of players)
      assert.deepEqual(await credits(p), {
        availableMinor: 24810,
        reservedMinor: 190,
      });
    assert.equal(
      (await pool.query('SELECT 1 FROM table_games WHERE table_id=$1', [id]))
        .rowCount,
      0,
    );
    const ready = await post(players[3], `tables/${id}/ready`, {
      operationId: randomUUID(),
    });
    assert.equal(ready.statusCode, 201, ready.body);
    const saved = await stored(id);
    for (let seat = 0; seat < 4; seat++) {
      const view = await room(players[seat]!, id),
        o = view.game.observation;
      assert.equal(view.table.capacity, 4);
      assert.equal(view.table.status, 'playing');
      assert.equal(view.game.engineVersion, '0.1.0');
      assert.equal(view.game.rulesVersion, rummy.RULES_VERSIONS.biriba);
      assert.equal(o.viewerSeat, seat);
      assert.deepEqual(
        o.players,
        players.map((p) => p.id),
      );
      assert.deepEqual(o.hand, saved.state.hands[seat]);
      assert.deepEqual(o.handCounts, [11, 11, 11, 11]);
      assert.deepEqual(o.reserveCounts, [11, 11]);
      assert.equal(o.stockCount, 41);
      assert.equal(o.trump, rummy.suitOf(saved.state.indicator));
      assert.equal(view.match.hasGameplay, false);
      assert.equal(
        JSON.stringify(view).includes(saved.state.initial.seed),
        false,
      );
      for (const secret of [
        'seed',
        'initial',
        'hands',
        'stock',
        'reserves',
        'turnDrawn',
        'history',
      ])
        assert.equal(Object.hasOwn(o, secret), false);
      assert.deepEqual(await credits(players[seat]!), {
        availableMinor: 24810,
        reservedMinor: 0,
      });
    }
  });

  void it('protects four-seat actions, deduplicates draws and checks selections read-only with permanent cancellation cutoff', async () => {
    const { players, id } = await started(),
      first = await room(players[0], id),
      actor = players[first.game.observation.turn]!,
      other = players[(first.game.observation.turn + 2) % 4]!;
    const before = await room(actor, id),
      original = await stored(id),
      funds = await Promise.all(players.map(credits));
    assert.equal(
      (await move(other, id, before, { type: 'draw', source: 'stock' }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await move(actor, id, before, {
          type: 'draw',
          source: 'stock',
          winnerIds: [actor.id, other.id],
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(await stored(id), original);
    assert.deepEqual(await Promise.all(players.map(credits)), funds);
    const operation = randomUUID(),
      response = await move(
        actor,
        id,
        before,
        { type: 'draw', source: 'stock' },
        operation,
      );
    assert.equal(response.statusCode, 201, response.body);
    const drawn = response.json<Room>();
    assert.deepEqual(
      (
        await move(
          actor,
          id,
          before,
          { type: 'draw', source: 'stock' },
          operation,
        )
      ).json(),
      drawn,
    );
    assert.equal(drawn.game.observation.hand.length, 12);
    assert.equal(drawn.match.hasGameplay, true);
    for (const p of players)
      assert.equal(
        (
          await post(p, `tables/${id}/cancel`, { operationId: randomUUID() })
        ).json<{ code: string }>().code,
        'cancellation_unavailable',
      );
    const saved = await stored(id),
      counts = async () =>
        (
          await pool.query<{
            events: number;
            operations: number;
            postings: number;
          }>(
            'SELECT (SELECT count(*) FROM match_events)::int AS events,(SELECT count(*) FROM platform_operations)::int AS operations,(SELECT count(*) FROM credit_postings)::int AS postings',
          )
        ).rows;
    const prior = await counts(),
      selection = { cards: [drawn.game.observation.hand[0]] },
      payload = { expectedRevision: drawn.game.revision, selection };
    const preview = await post(actor, `tables/${id}/selection`, payload);
    assert.equal(preview.statusCode, 201, preview.body);
    assert.equal(
      preview.json<{ preview: { discard: boolean } }>().preview.discard,
      true,
    );
    assert.equal(
      (await post(other, `tables/${id}/selection`, payload)).statusCode,
      400,
    );
    assert.deepEqual(await counts(), prior);
    assert.deepEqual(await stored(id), saved);
    assert.deepEqual(await Promise.all(players.map(credits)), funds);
    const fresh = await application();
    try {
      for (const p of players)
        assert.deepEqual(await room(p, id, fresh), await room(p, id));
    } finally {
      await fresh.close();
    }
  });

  async function live(p: Player, id: string) {
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === 'object');
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/multiplayer/v1/live`,
      { headers: { cookie: p.cookie, origin } },
    );
    sockets.add(socket);
    let resolve!: (value: Record<string, unknown>) => void;
    const first = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    const requestId = randomUUID();
    socket.on('message', (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const value = JSON.parse(bytes.toString('utf8')) as Record<
        string,
        unknown
      >;
      if (
        value.type === 'snapshot' &&
        (value.table as { id?: string } | null)?.id === id
      )
        resolve(value);
    });
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        id: requestId,
        type: 'subscribe',
        gameId: 'biriba',
        tableId: id,
      }),
    );
    const timer = setTimeout(() => socket.terminate(), 5000);
    try {
      return await Promise.race([
        first,
        once(socket, 'close').then(() => {
          throw new Error('Missing Biriba subscription snapshot');
        }),
      ]);
    } finally {
      clearTimeout(timer);
      socket.terminate();
      sockets.delete(socket);
    }
  }
  void it('keeps a private table out of discovery and gives each websocket only its own view, including partners', async () => {
    const code = 'Bir' + randomUUID().replaceAll('-', '').slice(0, 14),
      { players, id } = await started(app, code),
      visitor = await player();
    assert.equal((await get(visitor, `tables/${id}`)).statusCode, 404);
    assert.equal(
      (await post(visitor, 'private-access', { code })).statusCode,
      201,
    );
    assert.equal((await get(visitor, `tables/${id}/game`)).statusCode, 403);
    assert.equal(
      (await get(visitor, 'tables?gameId=biriba'))
        .json<{ tables: TableSnapshot[] }>()
        .tables.some((t) => t.id === id),
      false,
    );
    const state = (await stored(id)).state;
    for (let seat = 0; seat < 4; seat++) {
      const snap = await live(players[seat]!, id),
        game = snap.game as { observation: rummy.RummyObservation };
      assert.deepEqual(game.observation.hand, state.hands[seat]);
      assert.equal(game.observation.viewerSeat, seat);
      assert.equal(JSON.stringify(snap).includes(state.initial.seed), false);
    }
    assert.equal((await live(visitor, id)).game, undefined);
  });

  void it('refunds all four contributions and fees on a zero-gameplay cancellation exactly once', async () => {
    const { players, id } = await started(),
      operation = { operationId: randomUUID() },
      response = await post(players[2], `tables/${id}/cancel`, operation);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json<Room>().table.status, 'cancelled');
    assert.deepEqual(
      (await post(players[2], `tables/${id}/cancel`, operation)).json(),
      response.json(),
    );
    for (const p of players) {
      const current = await room(p, id);
      assert.equal(current.table.ticket?.state, 'refunded');
      assert.equal(current.match.outcome?.ownReturnMinor, 190);
      assert.deepEqual(await credits(p), {
        availableMinor: 25000,
        reservedMinor: 0,
      });
    }
    await reconciled(id);
  });
  void it('a forfeit awards the complete opposing partnership equal shares once, with no refund to the losing partner', async () => {
    const { players, id } = await started(),
      before = await room(players[0], id),
      payload = {
        operationId: randomUUID(),
        expectedRevision: before.game.revision,
      };
    const response = await post(players[0], `tables/${id}/forfeit`, payload);
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(
      response.json<Room>().match.outcome?.winnerUserIds.slice().sort(),
      [players[1].id, players[3].id].sort(),
    );
    assert.deepEqual(
      (await post(players[0], `tables/${id}/forfeit`, payload)).json(),
      response.json(),
    );
    for (let seat = 0; seat < 4; seat++) {
      const current = await room(players[seat]!, id);
      assert.equal(
        current.match.outcome?.ownReturnMinor,
        seat % 2 === 1 ? 200 : 0,
      );
      assert.equal(current.table.ticket?.state, 'settled');
      assert.deepEqual(await credits(players[seat]!), {
        availableMinor: 24810 + (seat % 2 === 1 ? 200 : 0),
        reservedMinor: 0,
      });
    }
    await reconciled(id);
  });

  void it(
    'completes a standard Biriba match from a reproducible server seed and settles both winners once',
    { timeout: 180_000 },
    async () => {
      const target = await application('0'.repeat(64));
      try {
        const { players, id } = await started(target);
        let current = await room(players[0], id, target),
          last: Room | undefined,
          finalAction: unknown,
          finalOp = '',
          finalPlayer = players[0],
          before = current,
          nexts = 0;
        for (
          let actions = 0;
          !current.match.outcome && actions < 2500;
          actions++
        ) {
          const seat =
              current.game.observation.phase === 'round-end'
                ? 3
                : current.game.observation.turn,
            actor = players[seat]!;
          before = await room(actor, id, target);
          const action = biribaMove(before.game.observation),
            operation = randomUUID();
          const response = await move(
            actor,
            id,
            before,
            action,
            operation,
            target,
          );
          assert.equal(response.statusCode, 201, response.body);
          current = response.json<Room>();
          assert.equal(current.game.revision, before.game.revision + 1);
          assert.equal(
            current.game.observation.ply,
            before.game.observation.ply + (action.type === 'next' ? 0 : 1),
          );
          if (action.type === 'next') {
            nexts++;
            assert.deepEqual(
              current.game.observation.scores,
              before.game.observation.scores,
            );
            assert.equal(
              (
                await post(
                  actor,
                  `tables/${id}/cancel`,
                  { operationId: randomUUID() },
                  target,
                )
              ).json<{ code: string }>().code,
              'cancellation_unavailable',
            );
          }
          if (current.match.outcome) {
            last = before;
            finalAction = action;
            finalOp = operation;
            finalPlayer = actor;
          }
        }
        assert.ok(current.match.outcome);
        assert.ok(nexts > 0);
        assert.ok(Math.max(...current.game.observation.scores) >= 2005);
        const winners = current.match.outcome.winnerUserIds;
        assert.equal(winners.length, 2);
        const winningSeats = winners
          .map((w) => players.findIndex((p) => p.id === w))
          .sort();
        assert.equal(winningSeats[1]! - winningSeats[0]!, 2);
        assert.deepEqual(
          (
            await move(finalPlayer, id, last!, finalAction, finalOp, target)
          ).json(),
          current,
        );
        const saved = (await stored(id)).state;
        assert.equal(saved.initial.mode, 'standard');
        assert.ok(rummy.restoreState(saved).ok);
        for (const p of players) {
          const result = await room(p, id, target);
          assert.equal(
            result.match.outcome!.ownReturnMinor,
            winners.includes(p.id) ? 200 : 0,
          );
          assert.equal(result.table.ticket?.state, 'settled');
          assert.deepEqual(await credits(p), {
            availableMinor: 24810 + (winners.includes(p.id) ? 200 : 0),
            reservedMinor: 0,
          });
        }
        assert.equal(
          (await get(players[0], 'tables?gameId=biriba', target))
            .json<{ tables: TableSnapshot[] }>()
            .tables.some((t) => t.id === id),
          false,
        );
        assert.equal(
          (await get(players[0], 'tickets', target))
            .json<{ tickets: { tableId: string }[] }>()
            .tickets.some((t) => t.tableId === id),
          true,
        );
        await reconciled(id);
      } finally {
        await target.close();
      }
    },
  );
});
