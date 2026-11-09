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
import * as tichu from '#engines/tichu';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import { TichuGameRuntime } from '../src/tables/card-game-runtime';
import type { TableSnapshot } from '../src/tables/platform.store';
import type { MatchSummary } from '../src/tables/match-lifecycle';
import { tichuMove } from './tichu-play';

interface Room {
  table: TableSnapshot;
  game: {
    status: string;
    revision: number;
    engineVersion: string;
    rulesVersion: string;
    observation: tichu.TichuObservation;
  };
  match: MatchSummary;
  balance: { availableMinor: number; reservedMinor: number };
}
void describe('four-player Tichu against PostgreSQL', () => {
  let admin: Pool, pool: Pool, app: NestFastifyApplication, url: string;
  const schema = 'tichu_' + randomUUID().replaceAll('-', ''),
    origin = 'https://tichu.skillbetting.invalid';
  const sockets = new Set<WebSocket>();
  async function application(seed?: string) {
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'tichu-isolated-code-secret'.repeat(3) })
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
      const engine = new TichuGameRuntime(),
        registry = new GameRuntimeRegistry();
      registry.register('tichu', {
        version: engine.version,
        start(input) {
          const validated = engine.start(input),
            created = tichu.createGame({
              players: validated.state.initial.players,
              seed,
              format: input.formatId as tichu.FormatId,
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
  async function table(
    target = app,
    privateCode?: string,
    formatId: tichu.FormatId = 'single',
  ) {
    const players = await Promise.all([player(), player(), player(), player()]);
    const response = await post(
      players[0],
      'tables',
      {
        operationId: randomUUID(),
        gameId: 'tichu',
        name: 'Tichu integration',
        visibility: privateCode ? 'private' : 'public',
        ...(privateCode ? { accessCode: privateCode } : {}),
        formatId,
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
  async function started(
    target = app,
    code?: string,
    format: tichu.FormatId = 'single',
  ) {
    const created = await table(target, code, format);
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
      await pool.query<{ state: tichu.TichuState; revision: number }>(
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
        gameId: 'tichu',
        tableId: id,
      }),
    );
    const timer = setTimeout(() => socket.terminate(), 5000);
    try {
      return await Promise.race([
        first,
        once(socket, 'close').then(() => {
          throw new Error('Missing Tichu subscription snapshot');
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
      (await get(visitor, 'tables?gameId=tichu'))
        .json<{ tables: TableSnapshot[] }>()
        .tables.some((t) => t.id === id),
      false,
    );
    const state = (await stored(id)).state;
    for (let seat = 0; seat < 4; seat++) {
      const snap = await live(players[seat]!, id),
        game = snap.game as { observation: tichu.TichuObservation };
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

  void it('waits for all four ready decisions and permits independent Grand responses with durable retry/cancellation cutoff', async () => {
    const { players, id } = await table();
    for (const p of players.slice(0, 3))
      assert.equal(
        (await post(p, `tables/${id}/ready`, { operationId: randomUUID() }))
          .statusCode,
        201,
      );
    assert.equal(
      (await get(players[0], `tables/${id}`)).json<Room>().game,
      undefined,
    );
    await post(players[3], `tables/${id}/ready`, {
      operationId: randomUUID(),
    });
    const initial = await room(players[3], id),
      op = randomUUID(),
      a = { type: 'grand', call: false };
    assert.equal(initial.game.observation.turn, null);
    assert.equal(initial.game.observation.yourMove, true);
    const accepted = await move(players[3], id, initial, a, op);
    assert.equal(accepted.statusCode, 201, accepted.body);
    assert.deepEqual(
      (await move(players[3], id, initial, a, op)).json(),
      accepted.json(),
    );
    assert.equal(
      (await move(players[0], id, initial, a)).json<{ code: string }>().code,
      'stale_game_revision',
    );
    assert.equal(
      (
        await post(players[0], `tables/${id}/cancel`, {
          operationId: randomUUID(),
        })
      ).json<{ code: string }>().code,
      'cancellation_unavailable',
    );
    const fresh = await application();
    try {
      const restored = await room(players[3], id, fresh);
      assert.deepEqual(restored.game, accepted.json<Room>().game);
    } finally {
      await fresh.close();
    }
  });
  void it('keeps exchanges private and exact selections read-only for independently committed actors', async () => {
    const { players, id } = await started();
    for (const p of players) {
      const v = await room(p, id);
      const r = await move(p, id, v, { type: 'grand', call: false });
      assert.equal(r.statusCode, 201, r.body);
    }
    for (const p of players) {
      const v = await room(p, id),
        r = await move(p, id, v, {
          type: 'exchange',
          cards: v.game.observation.hand.slice(0, 3),
        });
      assert.equal(r.statusCode, 201, r.body);
      for (const other of players) {
        const seen = await room(other, id);
        const receipt = (
          seen.game.observation as unknown as { lastPlay: { action: unknown } }
        ).lastPlay;
        assert.deepEqual(receipt.action, { type: 'exchange' });
      }
    }
    const saved = await stored(id),
      seat = saved.state.turn!,
      p = players[seat]!,
      v = await room(p, id),
      a = v.game.observation.legalActions.find((a) => a.type === 'play');
    assert.ok(a?.type === 'play');
    const funds = await credits(p),
      selection = {
        cards: a.cards,
        ...(a.wish === undefined ? {} : { wish: a.wish }),
      };
    const response = await post(p, `tables/${id}/selection`, {
      expectedRevision: v.game.revision,
      selection,
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.ok(
      response
        .json<{ preview: tichu.SelectionPreview }>()
        .preview.options.some((o) => o.option === a.option && o.legal),
    );
    assert.deepEqual(await stored(id), saved);
    assert.deepEqual(await credits(p), funds);
    const visitor = await player();
    assert.equal(
      (
        await post(visitor, `tables/${id}/selection`, {
          expectedRevision: v.game.revision,
          selection,
        })
      ).statusCode,
      403,
    );
  });
  for (const format of ['single', '500', '1000'] as const)
    void it(
      `completes a normal ${format} match and pays both teammates exactly once`,
      { timeout: 180_000 },
      async () => {
        const target = await application('0'.repeat(64));
        try {
          const { players, id } = await started(target, undefined, format);
          let current = await room(players[0], id, target),
            last = current,
            actor = players[0],
            finalAction: tichu.PlayerAction = { type: 'next' },
            finalOp = '',
            steps = 0,
            windows = 0;
          while (!current.match.outcome && steps++ < 8000) {
            let chosen: tichu.PlayerAction | null = null;
            for (const p of players) {
              const candidate = await room(p, id, target),
                a = tichuMove(candidate.game.observation);
              if (a) {
                chosen = a;
                actor = p;
                last = candidate;
                break;
              }
            }
            assert.ok(chosen);
            const op = randomUUID();
            const r = await move(actor, id, last, chosen, op, target);
            assert.equal(r.statusCode, 201, r.body);
            current = r.json<Room>();
            assert.equal(current.game.revision, last.game.revision + 1);
            assert.equal(
              current.game.observation.ply,
              last.game.observation.ply + (chosen.type === 'next' ? 0 : 1),
            );
            if (chosen.type === 'next')
              assert.deepEqual(
                current.game.observation.scores,
                last.game.observation.scores,
              );
            if (last.game.observation.phase === 'bomb-window') {
              windows++;
              assert.ok(last.game.observation.yourMove);
              assert.equal(chosen.type, 'continue');
            }
            if (current.match.outcome) {
              finalAction = chosen;
              finalOp = op;
            }
          }
          assert.ok(current.match.outcome);
          assert.ok(windows > 0);
          assert.equal(current.match.outcome.winnerUserIds.length, 2);
          assert.deepEqual(
            (await move(actor, id, last, finalAction, finalOp, target)).json(),
            current,
          );
          const winners = current.match.outcome.winnerUserIds,
            seats = winners.map((w) => players.findIndex((p) => p.id === w));
          assert.equal(Math.abs(seats[0]! - seats[1]!), 2);
          const saved = (await stored(id)).state;
          assert.equal(saved.initial.mode, 'standard');
          assert.equal(saved.initial.format, format);
          assert.ok(tichu.restoreState(saved).ok);
          for (const p of players) {
            const r = await room(p, id, target);
            assert.equal(
              r.match.outcome!.ownReturnMinor,
              winners.includes(p.id) ? 200 : 0,
            );
            assert.equal(r.table.ticket?.state, 'settled');
            assert.deepEqual(await credits(p), {
              availableMinor: 24810 + (winners.includes(p.id) ? 200 : 0),
              reservedMinor: 0,
            });
          }
          assert.equal(
            (await get(players[0], `tables?gameId=tichu`, target))
              .json<{ tables: TableSnapshot[] }>()
              .tables.some((t) => t.id === id),
            false,
          );
          assert.ok(
            (await get(players[0], 'tickets', target))
              .json<{ tickets: { tableId: string }[] }>()
              .tickets.some((t) => t.tableId === id),
          );
          await reconciled(id);
        } finally {
          await target.close();
        }
      },
    );
});
