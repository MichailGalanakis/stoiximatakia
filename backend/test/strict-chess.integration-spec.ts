import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import * as chess from '#engines/chess';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import { GameRuntimeRegistry } from '../src/tables/game-runtime';
import { StrictChessGameRuntime } from '../src/tables/strict-chess-game-runtime';
import { ArtifactChessGameRuntime } from '../src/tables/artifact-chess-game-runtime';
import type { TableSnapshot } from '../src/tables/platform.store';
import type { MatchSummary } from '../src/tables/match-lifecycle';

interface Room {
  table: TableSnapshot;
  game: {
    status: string;
    revision: number;
    engineVersion: string;
    rulesVersion: string;
    observation: chess.StrictChessObservation | chess.ArtifactChessObservation;
  };
  match: MatchSummary;
  balance: { availableMinor: number; reservedMinor: number };
}
const artifactProfile = process.env.CHESS_TEST_PROFILE === 'artifact';
const engineVersion = artifactProfile
  ? chess.ARTIFACT_ENGINE_VERSION
  : chess.STRICT_ENGINE_VERSION;
const rulesVersion = artifactProfile
  ? chess.ARTIFACT_RULES_VERSION
  : chess.STRICT_RULES_VERSION;
type ProofState = chess.StrictChessState | chess.ArtifactChessState;
void describe('unregistered strict chess with real workers against PostgreSQL', () => {
  let admin: Pool, pool: Pool, app: NestFastifyApplication, url: string;
  const schema = 'strict_chess_' + randomUUID().replaceAll('-', ''),
    origin = 'https://strict-chess.skillbetting.invalid';
  const applications = new Set<NestFastifyApplication>(),
    runtimes = new Set<StrictChessGameRuntime | ArtifactChessGameRuntime>();
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
    const runtime = artifactProfile
      ? new ArtifactChessGameRuntime({ connectionString: url })
      : await StrictChessGameRuntime.create();
    runtimes.add(runtime);
    registry.register('chess', runtime);
    builder.overrideProvider(GameRuntimeRegistry).useValue(registry);
    const module = await builder.compile();
    const instance = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(instance, { log() {}, warn() {}, error() {} });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    applications.add(instance);
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
    await Promise.all([...applications].map((instance) => instance.close()));
    await Promise.all([...runtimes].map((runtime) => runtime.close()));
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
  async function stored(id: string): Promise<ProofState> {
    return (
      await pool.query<{ state: ProofState }>(
        'SELECT state FROM table_games WHERE table_id=$1',
        [id],
      )
    ).rows[0]!.state;
  }
  async function reconciled(id: string) {
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
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM credit_accounts a WHERE balance_minor<>(SELECT coalesce(sum(amount_minor),0) FROM credit_postings p WHERE p.account_key=a.key)',
        )
      ).rowCount,
      0,
    );
  }
  async function opening(
    players: Awaited<ReturnType<typeof started>>['players'],
    id: string,
  ) {
    let current = await room(players[0], id);
    for (const [seat, from, to] of [
      [0, 'f2', 'f3'],
      [1, 'e7', 'e5'],
    ] as const) {
      const response = await move(players[seat], id, current, {
        type: 'move',
        from,
        to,
      });
      assert.equal(response.statusCode, 201, response.body);
      current = response.json<Room>();
    }
    return current;
  }

  void it('starts strict funded play through JSONB and settles a real worker-prepared checkmate exactly once', async () => {
    const { players, id } = await started();
    let current = await room(players[0], id);
    assert.equal(current.game.engineVersion, engineVersion);
    assert.equal(current.game.rulesVersion, rulesVersion);
    assert.equal(
      current.game.observation.conformance.unprovedContinuation,
      false,
    );
    assert.equal(current.game.observation.viewerColor, 'white');
    assert.equal(
      (await room(players[1], id)).game.observation.viewerColor,
      'black',
    );
    const untouched = await stored(id),
      funds = await credits(players[0]);
    for (const action of [
      { type: 'move', from: 'e2', to: 'e5' },
      { type: 'resign' },
      { type: 'move', from: 'f2', to: 'f3', evidence: 'browser-proof' },
    ]) {
      assert.equal(
        (await move(players[0], id, current, action)).json<{ code: string }>()
          .code,
        'invalid_game_action',
      );
      assert.deepEqual(await stored(id), untouched);
      assert.deepEqual(await credits(players[0]), funds);
    }
    for (const [index, coordinate] of [
      'f2f3',
      'e7e5',
      'g2g4',
      'd8h4',
    ].entries()) {
      const previous = await room(players[index % 2]!, id),
        operation = randomUUID(),
        action = {
          type: 'move',
          from: coordinate.slice(0, 2),
          to: coordinate.slice(2, 4),
        },
        response = await move(
          players[index % 2]!,
          id,
          previous,
          action,
          operation,
        );
      assert.equal(response.statusCode, 201, response.body);
      current = response.json<Room>();
      assert.equal(current.game.revision, previous.game.revision + 1);
      assert.equal(current.game.observation.revision, index + 1);
      assert.deepEqual(
        (
          await move(players[index % 2]!, id, previous, action, operation)
        ).json(),
        current,
      );
    }
    assert.deepEqual(
      current.game.observation.moves.map((m) => m.san),
      ['f3', 'e5', 'g4', 'Qh4#'],
    );
    assert.equal(current.game.status, 'completed');
    assert.deepEqual(current.match.outcome?.winnerUserIds, [players[1].id]);
    for (let seat = 0; seat < 2; seat++)
      assert.deepEqual(await credits(players[seat]!), {
        availableMinor: seat === 1 ? 25010 : 24810,
        reservedMinor: 0,
      });
    const state = await stored(id);
    assert.equal(state.schemaVersion, artifactProfile ? 3 : 2);
    assert.equal(state.engineVersion, engineVersion);
    assert.deepEqual(
      state.decisions.map((d) => d.revision),
      [0, 1, 2, 3, 4],
    );
    assert.equal(chess.restoreState(state).ok, false);
    if (artifactProfile) {
      assert.equal(chess.restoreArtifactState(state, []).ok, false);
      const refs = (
        await pool.query<{ decision_revision: number; artifact_id: Buffer }>(
          'SELECT decision_revision,artifact_id FROM match_chess_proof_refs WHERE table_id=$1 ORDER BY decision_revision',
          [id],
        )
      ).rows;
      assert.deepEqual(
        refs.map((ref) => ref.decision_revision),
        [0, 1, 2, 3, 4],
      );
      assert.deepEqual(
        refs.map((ref) => ref.artifact_id.toString('hex')),
        (state as chess.ArtifactChessState).decisions.map(
          (ref) => ref.artifactId,
        ),
      );
      assert.equal(JSON.stringify(state).includes('reachable-mate'), false);
      const verifier = new ArtifactChessGameRuntime({ connectionString: url });
      try {
        await verifier.warmObservations(state);
        assert.equal(
          verifier.observe({ state, userId: players[0].id }).phase,
          'ended',
        );
      } finally {
        await verifier.close();
      }
    } else assert.equal(chess.restoreStrictState(state).ok, true);
    assert.equal(
      (
        await move(players[0], id, current, {
          type: 'move',
          from: 'a2',
          to: 'a3',
        })
      ).json<{ code: string }>().code,
      'match_ended',
    );
    await reconciled(id);
  });

  void it('repairs a cold instance outside the read transaction and reuses unchanged engine views for the shared platform forfeit', async () => {
    const { players, id } = await started(),
      before = await opening(players, id),
      state = await stored(id),
      funds = await Promise.all(players.map(credits)),
      fresh = await application(),
      cold = await get(players[0], `tables/${id}`, fresh);
    assert.equal(cold.statusCode, 503, cold.body);
    assert.equal(cold.json<{ code: string }>().code, 'platform_unavailable');
    assert.deepEqual(await stored(id), state);
    assert.deepEqual(await Promise.all(players.map(credits)), funds);
    const runtime = fresh.get(GameRuntimeRegistry).get('chess') as
      StrictChessGameRuntime | ArtifactChessGameRuntime;
    await runtime.warmObservations(state);
    const repaired = await room(players[0], id, fresh);
    assert.equal(repaired.game.revision, before.game.revision);
    assert.equal(repaired.game.observation.fen, before.game.observation.fen);
    const payload = {
        operationId: randomUUID(),
        expectedRevision: repaired.game.revision,
      },
      response = await post(players[0], `tables/${id}/forfeit`, payload, fresh);
    assert.equal(response.statusCode, 201, response.body);
    const terminal = response.json<Room>();
    assert.equal(terminal.game.status, 'completed');
    assert.equal(terminal.game.observation.phase, 'playing');
    assert.equal(terminal.game.observation.matchOutcome, null);
    assert.equal(terminal.game.observation.revision, 2);
    assert.equal(terminal.game.revision, repaired.game.revision + 1);
    assert.deepEqual(terminal.match.outcome?.winnerUserIds, [players[1].id]);
    assert.deepEqual(
      (await post(players[0], `tables/${id}/forfeit`, payload, fresh)).json(),
      terminal,
    );
    assert.deepEqual(await credits(players[0]), {
      availableMinor: 24810,
      reservedMinor: 0,
    });
    assert.deepEqual(await credits(players[1]), {
      availableMinor: 25010,
      reservedMinor: 0,
    });
    await reconciled(id);
  });

  void it('counts accepted non-board decisions as gameplay and settles agreement without another proof or duplicate payout', async () => {
    const { players, id } = await started();
    let current = await opening(players, id);
    const decisions = (await stored(id)).decisions.length;
    for (const [seat, type] of [
      [0, 'offer-draw'],
      [1, 'accept-draw'],
    ] as const) {
      const before = await room(players[seat], id),
        operation = randomUUID(),
        response = await move(players[seat], id, before, { type }, operation);
      assert.equal(response.statusCode, 201, response.body);
      current = response.json<Room>();
      assert.equal(current.match.hasGameplay, true);
      assert.equal((await stored(id)).decisions.length, decisions);
      assert.deepEqual(
        (await move(players[seat], id, before, { type }, operation)).json(),
        current,
      );
      if (type === 'accept-draw') {
        const fresh = await application();
        // Durable operation receipts work even before any cold observation repair.
        assert.deepEqual(
          (
            await move(players[seat], id, before, { type }, operation, fresh)
          ).json(),
          current,
        );
      }
    }
    assert.equal(current.game.observation.ply, 2);
    assert.equal(
      current.game.observation.matchOutcome?.gameReason,
      'draw-agreement',
    );
    for (const p of players)
      assert.deepEqual(await credits(p), {
        availableMinor: 24910,
        reservedMinor: 0,
      });
    await reconciled(id);
  });
});
