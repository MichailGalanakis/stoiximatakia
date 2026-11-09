import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { before, after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { Chess } from 'chess.js';
import * as chess from '#engines/chess';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import {
  ChessGameRuntime,
  type ChessTableObservation,
} from '../src/tables/chess-game-runtime';
import type { TableSnapshot } from '../src/tables/platform.store';
import type { MatchSummary } from '../src/tables/match-lifecycle';
import { StrictChessGameRuntime } from '../src/tables/strict-chess-game-runtime';
import { ArtifactChessGameRuntime } from '../src/tables/artifact-chess-game-runtime';

// Explicit test-only profile: production registration remains unchanged.
const strictProfile = process.env.CHESS_TEST_PROFILE === 'strict';
const artifactProfile = process.env.CHESS_TEST_PROFILE === 'artifact';
const proofProfile = strictProfile || artifactProfile;
const engineVersion = artifactProfile
  ? chess.ARTIFACT_ENGINE_VERSION
  : strictProfile
    ? chess.STRICT_ENGINE_VERSION
    : chess.ENGINE_VERSION;
const rulesVersion = artifactProfile
  ? chess.ARTIFACT_RULES_VERSION
  : strictProfile
    ? chess.STRICT_RULES_VERSION
    : chess.RULES_VERSION;
type EngineState =
  chess.ChessState | chess.StrictChessState | chess.ArtifactChessState;

interface Room {
  table: TableSnapshot;
  game: {
    status: string;
    revision: number;
    engineVersion: string;
    rulesVersion: string;
    observation:
      | ChessTableObservation
      | chess.StrictChessObservation
      | chess.ArtifactChessObservation;
  };
  match: MatchSummary;
  balance: { availableMinor: number; reservedMinor: number };
}
void describe(
  proofProfile
    ? 'strict proof-worker chess acceptance against PostgreSQL'
    : 'prepared two-player chess against PostgreSQL',
  { timeout: proofProfile ? 3_600_000 : undefined },
  () => {
    let admin: Pool, pool: Pool, app: NestFastifyApplication, url: string;
    const schema = 'chess_' + randomUUID().replaceAll('-', ''),
      origin = 'https://chess.skillbetting.invalid';
    const sockets = new Set<WebSocket>();
    async function application() {
      const builder = Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(REGISTRATION_SETTINGS)
        .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
        .overrideProvider(PLATFORM_SETTINGS)
        .useValue({ codeSecret: 'chess-isolated-code-secret'.repeat(3) })
        .overrideProvider(VERIFICATION_CONFIG)
        .useValue({
          secret: undefined,
          resendKey: undefined,
          sevenKey: undefined,
          resendFrom: '',
          sevenSender: 'SkillBet',
        });
      // Test-only registration does not activate chess in the production module.
      const registry = new GameRuntimeRegistry();
      registry.register(
        'chess',
        artifactProfile
          ? new ArtifactChessGameRuntime({ connectionString: url })
          : strictProfile
            ? await StrictChessGameRuntime.create()
            : new ChessGameRuntime(),
      );
      builder.overrideProvider(GameRuntimeRegistry).useValue(registry);
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
      const players = await Promise.all([player(), player()]);
      const response = await post(
        players[0],
        'tables',
        {
          operationId: randomUUID(),
          gameId: 'chess',
          name: 'Chess integration',
          visibility: privateCode ? 'private' : 'public',
          ...(privateCode ? { accessCode: privateCode } : {}),
          formatId: 'standard',
          prizeContributionMinor: 100,
        },
        target,
      );
      assert.equal(response.statusCode, 201, response.body);
      const id = response.json<Room>().table.id;
      for (let seat = 1; seat < 2; seat++) {
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
      let response = await get(p, `tables/${id}`, target);
      if (proofProfile) {
        // Only expected room recovery retries cold cache repair; direct get/error
        // assertions retain the raw response. Operational failures still fail.
        for (
          let attempt = 0;
          attempt < 300 && response.statusCode === 503;
          attempt++
        ) {
          await delay(100);
          response = await get(p, `tables/${id}`, target);
        }
      }
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
        await pool.query<{ state: EngineState; revision: number }>(
          'SELECT state,revision FROM table_games WHERE table_id=$1',
          [id],
        )
      ).rows[0]!;
    async function restorable(state: EngineState): Promise<boolean> {
      if (!artifactProfile)
        return strictProfile
          ? chess.restoreStrictState(state).ok
          : chess.restoreState(state).ok;
      const runtime = new ArtifactChessGameRuntime({ connectionString: url });
      try {
        await runtime.warmObservations(state);
        return (
          runtime.observe({ state, userId: state.initial.players.white })
            .fen === state.fen
        );
      } finally {
        await runtime.close();
      }
    }
    async function playLine(players: Player[], id: string, line: string) {
      let current = await room(players[0]!, id),
        previous = current,
        actor = players[0]!,
        action: chess.MoveAction = { type: 'move', from: 'a2', to: 'a3' },
        operationId = '';
      for (const uci of line.split(' ')) {
        const parsed = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
        assert.ok(parsed);
        previous = current;
        actor = players.find(
          (p) =>
            p.id ===
            current.game.observation.players[current.game.observation.turn],
        )!;
        action = {
          type: 'move',
          from: parsed[1] as chess.Square,
          to: parsed[2] as chess.Square,
          ...(parsed[3] ? { promotion: parsed[3] as chess.Promotion } : {}),
        };
        operationId = randomUUID();
        const response = await move(actor, id, previous, action, operationId);
        assert.equal(response.statusCode, 201, `${uci}: ${response.body}`);
        current = response.json<Room>();
        assert.equal(current.game.revision, previous.game.revision + 1);
        assert.equal(
          current.game.observation.ply,
          previous.game.observation.ply + 1,
        );
      }
      return { current, previous, actor, action, operationId };
    }
    async function restoredRetry(
      id: string,
      last: Awaited<ReturnType<typeof playLine>>,
    ) {
      const fresh = await application();
      try {
        assert.deepEqual(
          (await room(last.actor, id, fresh)).game,
          last.current.game,
        );
        assert.deepEqual(
          (
            await move(
              last.actor,
              id,
              last.previous,
              last.action,
              last.operationId,
              fresh,
            )
          ).json(),
          last.current,
        );
      } finally {
        await fresh.close();
      }
    }
    async function drawPaid(players: Player[], id: string, reason: string) {
      for (const p of players) {
        const current = await room(p, id);
        assert.equal(current.match.outcome?.kind, 'draw');
        assert.equal(current.game.observation.matchOutcome?.gameReason, reason);
        assert.equal(current.match.outcome?.ownReturnMinor, 100);
        assert.equal(current.table.ticket?.state, 'settled');
        assert.deepEqual(await credits(p), {
          availableMinor: 24910,
          reservedMinor: 0,
        });
      }
      const state = (await stored(id)).state;
      assert.equal(state.initial.mode, 'standard');
      assert.ok(await restorable(state));
      await reconciled(id);
    }
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
          await pool.query(
            'SELECT 1 FROM match_settlements WHERE table_id=$1',
            [id],
          )
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
          gameId: 'chess',
          tableId: id,
        }),
      );
      const timer = setTimeout(() => socket.terminate(), 5000);
      try {
        return await Promise.race([
          first,
          once(socket, 'close').then(() => {
            throw new Error('Missing chess subscription snapshot');
          }),
        ]);
      } finally {
        clearTimeout(timer);
        socket.terminate();
        sockets.delete(socket);
      }
    }

    void it('waits for both funded players and projects participant-only chess over HTTP and native websocket', async () => {
      const code = 'Chess' + randomUUID().replaceAll('-', '').slice(0, 12),
        { players, id } = await table(app, code),
        visitor = await player();
      assert.equal(
        (
          await post(players[0], `tables/${id}/ready`, {
            operationId: randomUUID(),
          })
        ).statusCode,
        201,
      );
      assert.equal(
        (await get(players[0], `tables/${id}`)).json<Room>().game,
        undefined,
      );
      assert.equal(
        (
          await post(players[1], `tables/${id}/ready`, {
            operationId: randomUUID(),
          })
        ).statusCode,
        201,
      );
      const before = await room(players[0], id);
      assert.equal(before.game.rulesVersion, rulesVersion);
      assert.equal(before.game.engineVersion, engineVersion);
      assert.equal(before.game.observation.viewerColor, 'white');
      assert.equal(
        (await room(players[1], id)).game.observation.viewerColor,
        'black',
      );
      assert.equal((await get(visitor, `tables/${id}`)).statusCode, 404);
      assert.equal(
        (await post(visitor, 'private-access', { code })).statusCode,
        201,
      );
      assert.equal((await get(visitor, `tables/${id}/game`)).statusCode, 403);
      assert.equal(
        (await get(visitor, 'tables?gameId=chess'))
          .json<{ tables: TableSnapshot[] }>()
          .tables.some((t) => t.id === id),
        false,
      );
      for (let seat = 0; seat < 2; seat++) {
        const snapshot = await live(players[seat]!, id),
          game = snapshot.game as Room['game'];
        assert.equal(game.observation.viewer, players[seat]!.id);
        assert.equal(
          game.observation.viewerColor,
          seat === 0 ? 'white' : 'black',
        );
        assert.equal(Object.hasOwn(game, 'state'), false);
        assert.equal(Object.hasOwn(game.observation, 'history'), false);
      }
      assert.equal((await live(visitor, id)).game, undefined);
    });

    void it('keeps the creator in white seat 0 without changing tickets, readiness or money when black seat 1 is still empty', async () => {
      const creator = await player(),
        response = await post(creator, 'tables', {
          operationId: randomUUID(),
          gameId: 'chess',
          name: 'Fixed chess colours',
          visibility: 'public',
          formatId: 'standard',
          prizeContributionMinor: 100,
        });
      assert.equal(response.statusCode, 201, response.body);
      const id = response.json<Room>().table.id,
        snapshot = async () => ({
          table: (await get(creator, `tables/${id}`)).json<Room>().table,
          funds: await credits(creator),
          participation: (
            await pool.query<{
              user_id: string;
              seat_index: number;
              ticket_id: string;
              ready: boolean;
            }>(
              'SELECT user_id,seat_index,ticket_id,ready FROM table_participations WHERE table_id=$1',
              [id],
            )
          ).rows,
          tickets: (await get(creator, 'tickets')).json<unknown>(),
          postings: (
            await pool.query<{ count: string }>(
              'SELECT count(*) FROM credit_postings',
            )
          ).rows[0]!.count,
        }),
        before = await snapshot(),
        payload = { operationId: randomUUID(), seatIndex: 1 };
      assert.equal(before.participation.length, 1);
      assert.equal(before.participation[0]?.seat_index, 0);
      const rejected = await post(creator, `tables/${id}/seat`, payload);
      assert.equal(rejected.statusCode, 409, rejected.body);
      assert.equal(rejected.json<{ code: string }>().code, 'seat_unavailable');
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        (await post(creator, `tables/${id}/seat`, payload)).statusCode,
        409,
      );
      assert.deepEqual(await snapshot(), before);
      const unchanged = await post(creator, `tables/${id}/seat`, {
        operationId: randomUUID(),
        seatIndex: 0,
      });
      assert.equal(unchanged.statusCode, 201, unchanged.body);
      assert.deepEqual(await snapshot(), before);
    });

    void it('rejects illegal/spoofed actions atomically and restores a lost acknowledged move after restart', async () => {
      const { players, id } = await started(),
        initial = await room(players[0], id),
        saved = await stored(id),
        funds = await credits(players[0]),
        action = { type: 'move', from: 'e2', to: 'e4' },
        operation = randomUUID();
      for (const [actor, rejected] of [
        [players[1], { type: 'move', from: 'e7', to: 'e5' }],
        [players[0], { type: 'move', from: 'e2', to: 'e5' }],
        [players[0], { ...action, winnerId: players[0].id }],
        [players[0], { type: 'resign' }],
        [
          players[0],
          { type: 'dead-position', authority: 'browser', evidence: 'draw' },
        ],
      ] as const) {
        assert.equal(
          (await move(actor, id, initial, rejected)).json<{ code: string }>()
            .code,
          'invalid_game_action',
        );
        assert.deepEqual(await stored(id), saved);
        assert.deepEqual(await credits(players[0]), funds);
      }
      const accepted = await move(players[0], id, initial, action, operation);
      assert.equal(accepted.statusCode, 201, accepted.body);
      assert.deepEqual(
        (await move(players[0], id, initial, action, operation)).json(),
        accepted.json(),
      );
      assert.equal(
        (await move(players[0], id, initial, action)).json<{ code: string }>()
          .code,
        'stale_game_revision',
      );
      assert.equal(
        (
          await post(players[1], `tables/${id}/cancel`, {
            operationId: randomUUID(),
          })
        ).json<{ code: string }>().code,
        'cancellation_unavailable',
      );
      const fresh = await application();
      try {
        assert.deepEqual(
          (await room(players[0], id, fresh)).game,
          accepted.json<Room>().game,
        );
      } finally {
        await fresh.close();
      }
    });

    void it('settles a standard checkmate exactly once with durable SAN history and balanced payouts', async () => {
      const { players, id } = await started();
      let current = await room(players[0], id),
        previous = current,
        finalOperation = '';
      const sequence = [
        ['f2', 'f3'],
        ['e7', 'e5'],
        ['g2', 'g4'],
        ['d8', 'h4'],
      ] as const;
      for (let step = 0; step < sequence.length; step++) {
        const [from, to] = sequence[step]!;
        previous = await room(players[step % 2]!, id);
        finalOperation = randomUUID();
        const response = await move(
          players[step % 2]!,
          id,
          previous,
          { type: 'move', from, to },
          finalOperation,
        );
        assert.equal(response.statusCode, 201, response.body);
        current = response.json<Room>();
      }
      assert.deepEqual(current.match.outcome?.winnerUserIds, [players[1].id]);
      assert.equal(
        current.game.observation.matchOutcome?.gameReason,
        'checkmate',
      );
      assert.deepEqual(
        current.game.observation.moves.map((m) => m.san),
        ['f3', 'e5', 'g4', 'Qh4#'],
      );
      assert.deepEqual(
        (
          await move(
            players[1],
            id,
            previous,
            { type: 'move', from: 'd8', to: 'h4' },
            finalOperation,
          )
        ).json(),
        current,
      );
      for (let seat = 0; seat < 2; seat++) {
        const snapshot = await room(players[seat]!, id);
        assert.equal(
          snapshot.match.outcome?.ownReturnMinor,
          seat === 1 ? 200 : 0,
        );
        assert.equal(snapshot.table.ticket?.state, 'settled');
        assert.deepEqual(await credits(players[seat]!), {
          availableMinor: seat === 1 ? 25010 : 24810,
          reservedMinor: 0,
        });
      }
      const state = (await stored(id)).state;
      assert.equal(state.initial.mode, 'standard');
      assert.ok(await restorable(state));
      await reconciled(id);
    });

    void it('returns draw contributions and retains fees exactly once on an accepted draw offer', async () => {
      const { players, id } = await started();
      for (const [seat, action] of [
        [0, { type: 'move', from: 'e2', to: 'e4' }],
        [1, { type: 'move', from: 'e7', to: 'e5' }],
        [0, { type: 'offer-draw' }],
      ] as const) {
        const before = await room(players[seat], id),
          response = await move(players[seat], id, before, action);
        assert.equal(response.statusCode, 201, response.body);
      }
      const before = await room(players[1], id),
        operation = randomUUID(),
        response = await move(
          players[1],
          id,
          before,
          { type: 'accept-draw' },
          operation,
        );
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(
        response.json<Room>().game.observation.matchOutcome?.gameReason,
        'draw-agreement',
      );
      assert.deepEqual(
        (
          await move(players[1], id, before, { type: 'accept-draw' }, operation)
        ).json(),
        response.json(),
      );
      for (const p of players) {
        assert.equal((await room(p, id)).match.outcome?.ownReturnMinor, 100);
        assert.deepEqual(await credits(p), {
          availableMinor: 24910,
          reservedMinor: 0,
        });
      }
      await reconciled(id);
    });

    void it('preserves the shared explicit forfeit policy and zero-command cancellation refunds', async () => {
      const forfeited = await started(),
        before = await room(forfeited.players[0], forfeited.id),
        payload = {
          operationId: randomUUID(),
          expectedRevision: before.game.revision,
        },
        response = await post(
          forfeited.players[0],
          `tables/${forfeited.id}/forfeit`,
          payload,
        );
      assert.equal(response.statusCode, 201, response.body);
      assert.deepEqual(response.json<Room>().match.outcome?.winnerUserIds, [
        forfeited.players[1].id,
      ]);
      assert.deepEqual(
        (
          await post(
            forfeited.players[0],
            `tables/${forfeited.id}/forfeit`,
            payload,
          )
        ).json(),
        response.json(),
      );
      assert.deepEqual(await credits(forfeited.players[0]), {
        availableMinor: 24810,
        reservedMinor: 0,
      });
      assert.deepEqual(await credits(forfeited.players[1]), {
        availableMinor: 25010,
        reservedMinor: 0,
      });
      await reconciled(forfeited.id);
      const cancelled = await started(),
        operation = { operationId: randomUUID() },
        cancel = await post(
          cancelled.players[0],
          `tables/${cancelled.id}/cancel`,
          operation,
        );
      assert.equal(cancel.statusCode, 201, cancel.body);
      assert.deepEqual(
        (
          await post(
            cancelled.players[0],
            `tables/${cancelled.id}/cancel`,
            operation,
          )
        ).json(),
        cancel.json(),
      );
      for (const p of cancelled.players)
        assert.deepEqual(await credits(p), {
          availableMinor: 25000,
          reservedMinor: 0,
        });
      await reconciled(cancelled.id);
    });

    void it('persists both castles as one revision each and replays SAN and exact retries after restart', async () => {
      const { players, id } = await started(),
        last = await playLine(
          players,
          id,
          'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1 f8e7 d2d3 e8g8',
        );
      assert.deepEqual(
        last.current.game.observation.moves
          .filter((m) => m.san === 'O-O')
          .map((m) => m.by),
        ['white', 'black'],
      );
      const board = chess.parseFen(last.current.game.observation.fen);
      assert.equal(board.board[6], 'K');
      assert.equal(board.board[5], 'R');
      assert.equal(board.board[62], 'k');
      assert.equal(board.board[61], 'r');
      assert.equal(last.current.match.outcome, null);
      await restoredRetry(id, last);
    });

    void it('persists en-passant capture and rejects the same destination after the right expires', async () => {
      const immediate = await started(),
        last = await playLine(
          immediate.players,
          immediate.id,
          'e2e4 a7a6 e4e5 d7d5 e5d6',
        );
      assert.equal(last.current.game.observation.moves.at(-1)?.san, 'exd6');
      const board = chess.parseFen(last.current.game.observation.fen);
      assert.equal(board.board[43], 'P');
      assert.equal(board.board[35], null);
      await restoredRetry(immediate.id, last);
      const expired = await started(),
        before = await playLine(
          expired.players,
          expired.id,
          'e2e4 a7a6 e4e5 d7d5 g1f3 h7h6',
        ),
        saved = await stored(expired.id),
        response = await move(expired.players[0], expired.id, before.current, {
          type: 'move',
          from: 'e5',
          to: 'd6',
        });
      assert.equal(
        response.json<{ code: string }>().code,
        'invalid_game_action',
      );
      assert.deepEqual(await stored(expired.id), saved);
      assert.equal(
        (await room(expired.players[0], expired.id)).match.outcome,
        null,
      );
    });

    for (const promotion of ['q', 'r', 'b', 'n'] as const)
      void it(`restores and retries a standard-start capture-promotion to ${promotion} without duplicate moves or payment`, async () => {
        const { players, id } = await started(),
          before = await playLine(
            players,
            id,
            'a2a4 b7b5 a4b5 a7a6 b5a6 h7h6 a6a7 h6h5',
          ),
          saved = await stored(id);
        // The browser must provide a piece; the server never silently chooses a queen.
        assert.equal(
          (
            await move(players[0], id, before.current, {
              type: 'move',
              from: 'a7',
              to: 'b8',
            })
          ).json<{ code: string }>().code,
          'invalid_game_action',
        );
        assert.deepEqual(await stored(id), saved);
        const last = await playLine(players, id, `a7b8${promotion}`);
        assert.equal(
          last.current.game.observation.moves.at(-1)?.san,
          `axb8=${promotion.toUpperCase()}`,
        );
        assert.equal(
          chess.parseFen(last.current.game.observation.fen).board[57],
          promotion.toUpperCase(),
        );
        assert.equal(last.current.game.observation.ply, 9);
        assert.equal(last.current.match.outcome, null);
        assert.deepEqual(await credits(players[0]), {
          availableMinor: 24810,
          reservedMinor: 0,
        });
        await restoredRetry(id, last);
      });

    for (const intended of [false, true])
      void it(`settles a ${intended ? 'declared intended-move' : 'current-position'} repetition claim once from complete standard history`, async () => {
        const { players, id } = await started(),
          cycle = 'g1f3 g8f6 f3g1 f6g8',
          line = `${cycle} ${cycle}`.split(' '),
          last = await playLine(
            players,
            id,
            line.slice(0, intended ? 7 : 8).join(' '),
          ),
          actor = players[intended ? 1 : 0],
          action = {
            type: 'claim-draw',
            reason: 'threefold-repetition',
            ...(intended ? { intendedMove: { from: 'f6', to: 'g8' } } : {}),
          },
          operation = randomUUID(),
          response = await move(actor, id, last.current, action, operation);
        assert.equal(response.statusCode, 201, response.body);
        const terminal = response.json<Room>();
        assert.equal(terminal.game.observation.ply, intended ? 7 : 8);
        assert.equal(terminal.game.revision, last.current.game.revision + 1);
        assert.deepEqual(
          (await move(actor, id, last.current, action, operation)).json(),
          terminal,
        );
        const fresh = await application();
        try {
          assert.deepEqual((await room(actor, id, fresh)).game, terminal.game);
        } finally {
          await fresh.close();
        }
        await drawPaid(players, id, 'threefold-repetition');
      });

    void it('automatically settles the fifth repetition without a player claim or duplicate draw payout', async () => {
      const { players, id } = await started(),
        cycle = 'g1f3 g8f6 f3g1 f6g8',
        last = await playLine(
          players,
          id,
          [cycle, cycle, cycle, cycle].join(' '),
        );
      assert.equal(last.current.game.observation.ply, 16);
      assert.equal(
        last.current.game.observation.matchOutcome?.gameReason,
        'fivefold-repetition',
      );
      await restoredRetry(id, last);
      await drawPaid(players, id, 'fivefold-repetition');
    });

    // Independent chess.js development oracle generated this complete standard-start
    // witness: only noncapturing knight moves, no checks, and at most two visits per
    // position. No FEN counters, analysis roots or authoritative snapshots are altered.
    const quietKnightLine =
      'b1c3 g8h6 c3a4 b8c6 a4b6 h6g8 b6a4 g8h6 g1h3 h6g4 a4b6 c6b8 h3f4 g4f6 f4h3 f6d5 h3g5 d5e3 g5e6 e3c4 e6g5 c4e3 b6a4 e3f5 a4b6 f5h6 g5e6 h6g8 b6c4 b8a6 c4e3 g8h6 e6g5 h6g8 g5h3 a6b8 e3g4 g8f6 h3g5 f6d5 g4e3 b8c6 g5e4 c6a5 e4c5 a5c6 c5e6 d5b4 e6c5 b4a6 e3c4 c6b8 c5a4 a6c5 a4c3 b8c6 c4e5 c5b3 c3e4 c6d4 e5c6 b3a5 c6b8 d4c6 b8a6 c6e5 a6b4 e5g6 e4c5 g6f4 c5e6 f4h5 e6c5 h5f4 c5a4 f4d5 a4c5 a5c6 c5b3 c6d4 b4c6 d4b5 b3c5 d5f4 c5a6 b5c3 c6b8 c3b5 a6c5 b5d6 c5e4 f4h3 b8c6 d6f5 c6d4 f5h6 d4f5 h3f4 e4g5 h6g8 g5h3 f4h5 h3g1 g8f6 f5d4 f6e4 d4e6 h5f4 e6d4 e4g5 d4b5 f4g6 b5c3 g6h4 c3b5 g5e6 g1f3 h4g6 f3g1 g6h4 g1h3 e6g5 b5d4 g5e6 d4c6 h4f5 c6b4 e6c5 h3g5 f5d4 b4a6 c5b3 g5e6 b3c5 a6b8 c5a4 b8a6 d4f5 a6b8 f5e3 e6d4 a4c3 d4c6 e3d5 c6b4 d5f4 b8a6 f4g6 a6c5 c3d5'.split(
        ' ',
      );

    for (const intended of [false, true])
      void it(`settles a fifty-move ${intended ? 'intended-move' : 'current-position'} claim from an unmodified standard-start history`, async () => {
        const { players, id } = await started(),
          plies = intended ? 99 : 100,
          last = await playLine(
            players,
            id,
            quietKnightLine.slice(0, plies).join(' '),
          ),
          actor = players[intended ? 1 : 0],
          next = quietKnightLine[99]!,
          action = {
            type: 'claim-draw',
            reason: 'fifty-move',
            ...(intended
              ? {
                  intendedMove: {
                    from: next.slice(0, 2),
                    to: next.slice(2, 4),
                  },
                }
              : {}),
          },
          operation = randomUUID(),
          response = await move(actor, id, last.current, action, operation);
        assert.equal(response.statusCode, 201, response.body);
        assert.equal(response.json<Room>().game.observation.ply, plies);
        assert.deepEqual(
          (await move(actor, id, last.current, action, operation)).json(),
          response.json(),
        );
        await drawPaid(players, id, 'fifty-move');
      });

    void it('automatically settles the seventy-five-move limit after 150 actual reversible plies and survives terminal retry/restart', async () => {
      const { players, id } = await started(),
        last = await playLine(players, id, quietKnightLine.join(' ')),
        state = (await stored(id)).state;
      assert.equal(state.ply, 150);
      assert.equal(chess.parseFen(state.fen).halfmove, 150);
      const visits = new Map<string, number>();
      for (const key of state.positionHistory)
        visits.set(key, (visits.get(key) ?? 0) + 1);
      assert.ok(Math.max(...visits.values()) <= 2);
      await restoredRetry(id, last);
      await drawPaid(players, id, 'seventy-five-move');
    });

    void it(
      'settles a dead-position draw by the published standard-reachable boundary and refuses subsequent moves',
      { timeout: proofProfile ? 1_800_000 : 120_000 },
      async (context) => {
        const fixture = JSON.parse(
            await readFile(
              'engines/chess/test/standard-dead-proofgame.json',
              'utf8',
            ),
          ) as { pgn: string; fen: string },
          oracle = new Chess();
        oracle.loadPgn(fixture.pgn);
        const moves = oracle.history({ verbose: true });
        assert.equal(moves.length, 112);
        assert.equal(oracle.fen(), fixture.fen);
        const { players, id } = await started();
        let last: Awaited<ReturnType<typeof playLine>> | undefined;
        for (const candidate of moves) {
          if (last?.current.game.observation.phase === 'ended') break;
          last = await playLine(
            players,
            id,
            candidate.from + candidate.to + (candidate.promotion ?? ''),
          );
        }
        assert.ok(last);
        const current = last.current.game.observation,
          acceptedPlies = current.ply;
        // The published final position is established dead. The earliest dead
        // prefix has not been independently established; accept an earlier sound
        // detection and never continue construction moves after a terminal result.
        assert.equal(last.previous.match.outcome, null);
        assert.ok(acceptedPlies <= moves.length);
        assert.equal(current.phase, 'ended');
        assert.equal(current.matchOutcome?.gameReason, 'dead-position-proven');
        context.diagnostic(
          `${engineVersion}: first terminal ply ${acceptedPlies}, ${current.moves.at(-1)?.san}, ${current.matchOutcome.gameReason}`,
        );
        assert.deepEqual(
          current.moves.map((m) => m.san),
          moves.slice(0, acceptedPlies).map((m) => m.san),
        );
        const state = (await stored(id)).state;
        assert.equal(state.initial.mode, 'standard');
        assert.equal(state.initial.fen, chess.START_FEN);
        assert.equal(state.history.length, acceptedPlies);
        assert.equal(state.positionHistory.length, acceptedPlies + 1);
        await restoredRetry(id, last);
        await drawPaid(players, id, 'dead-position-proven');
        const later =
            moves[acceptedPlies] ?? oracle.moves({ verbose: true })[0]!,
          actor = players.find((p) => p.id === current.players[current.turn])!,
          saved = await stored(id),
          funds = await Promise.all(players.map(credits)),
          rejected = await move(actor, id, last.current, {
            type: 'move',
            from: later.from,
            to: later.to,
          });
        assert.equal(rejected.statusCode, 409, rejected.body);
        assert.equal(rejected.json<{ code: string }>().code, 'match_ended');
        assert.deepEqual(await stored(id), saved);
        assert.deepEqual(await Promise.all(players.map(credits)), funds);
        await reconciled(id);
      },
    );
  },
);
