import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import * as chessEngine from '#engines/chess';
import * as diloti from '#engines/diloti';
import * as rummy from '#engines/rummy';
import * as tichu from '#engines/tichu';
import * as xeri from '#engines/xeri';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import type { HouseGameView } from '../src/house/house-game.store';
import { REGISTRATION_SETTINGS } from '../src/registration/registration-settings';
import { tokenDigest } from '../src/registration/registration.service';
import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import {
  BiribaGameRuntime,
  DilotiGameRuntime,
  KoumkanGameRuntime,
  ThanasisGameRuntime,
  TichuGameRuntime,
  XeriGameRuntime,
} from '../src/tables/card-game-runtime';
import { ChessGameRuntime } from '../src/tables/chess-game-runtime';
import type { GameId } from '../src/tables/game-catalog';
import {
  GameRuntimeRegistry,
  type GameActionInput,
  type GameStartInput,
  type TableGameRuntime,
} from '../src/tables/game-runtime';
import { PLATFORM_SETTINGS } from '../src/tables/platform-settings';
import { PlatformError } from '../src/tables/platform-error';
import { signSandboxEvent } from '../src/wallet/payment-provider';
import { WALLET_SETTINGS } from '../src/wallet/wallet-settings';

/** Production chess only accepts detached preparation; mirror that shape here. */
class DetachedChessRuntime implements TableGameRuntime {
  private readonly inner = new ChessGameRuntime();
  readonly version = this.inner.version;
  start(): never {
    throw new PlatformError('engine_unavailable', 503);
  }
  prepareStart(input: GameStartInput) {
    return Promise.resolve(this.inner.start(input));
  }
  prepare(input: GameActionInput) {
    return Promise.resolve(this.inner.apply(input));
  }
  observe(input: { state: unknown; userId: string }) {
    return this.inner.observe(input);
  }
}

type Choose = (
  observation: never,
  options: { strategy: 'random'; randomState: number },
) =>
  | { ok: true; value: { action: unknown; nextRandomState: number | null } }
  | { ok: false; error: { code: string } };
const HUMAN: Record<GameId, Choose> = {
  xeri: xeri.chooseBotAction,
  diloti: diloti.chooseBotAction,
  koumkan: rummy.chooseBotAction,
  thanasis: rummy.chooseBotAction,
  biriba: rummy.chooseBotAction,
  tichu: tichu.chooseBotAction,
  chess: chessEngine.chooseBotAction,
};

void describe('player-vs-platform games against bots', () => {
  let app: NestFastifyApplication, admin: Pool, pool: Pool, url: string;
  const schema = 'housegames_' + randomUUID().replaceAll('-', '');
  const origin = 'https://test.skillbetting.invalid';
  const secret = 'sandbox-webhook-secret-'.repeat(2);
  const adminToken = 'wallet-admin-token-'.repeat(2);
  const offerId = 'stake-5-prize-8';
  const headers = {
    origin,
    'x-skillbetting-client': 'web-v1',
    'content-type': 'application/json',
  };

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
      .sort()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(await readFile('migrations/' + file, 'utf8'));
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
    const registry = new GameRuntimeRegistry();
    registry.register('xeri', new XeriGameRuntime());
    registry.register('diloti', new DilotiGameRuntime());
    registry.register('koumkan', new KoumkanGameRuntime());
    registry.register('thanasis', new ThanasisGameRuntime());
    registry.register('biriba', new BiribaGameRuntime());
    registry.register('tichu', new TichuGameRuntime());
    registry.register('chess', new DetachedChessRuntime());
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GameRuntimeRegistry)
      .useValue(registry)
      .overrideProvider(REGISTRATION_SETTINGS)
      .useValue({ databaseUrl: url, appOrigin: origin, secureCookie: true })
      .overrideProvider(PLATFORM_SETTINGS)
      .useValue({ codeSecret: 'isolated-table-secret-'.repeat(3) })
      .overrideProvider(WALLET_SETTINGS)
      .useValue({
        sandboxSecret: secret,
        adminToken,
        minDepositMinor: 500,
        maxDepositMinor: 100_000,
        minWithdrawalMinor: 1000,
        withdrawalsPerDay: 3,
        withdrawalFloorMinor: 10_000,
        withdrawalShareBps: 8000,
      })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false, rawBody: true },
    );
    configureApplication(app, {
      log: () => {},
      error: () => {},
      warn: () => {},
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const reserve = await adminPost('house/capital', {
      operationId: randomUUID(),
      direction: 'in',
      amountMinor: 100_000,
      reviewer: 'test-setup',
    });
    assert.equal(reserve.statusCode, 200, reserve.body);
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  function adminPost(path: string, payload: unknown) {
    return app.inject({
      method: 'POST',
      url: '/wallet/v1/admin/' + path,
      headers: {
        authorization: 'Bearer ' + adminToken,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  }
  async function player(verified = true) {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at,email_verified)
       VALUES($1,$2,$2,'unused-test-password',$3,$4,'registered','test-terms',now(),$5)`,
      [
        id,
        'G_' + id.replaceAll('-', '').slice(0, 20),
        id + '@example.com',
        '+3069' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
        verified,
      ],
    );
    await pool.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [tokenDigest(token), id],
    );
    return { id, cookie: '__Host-sb_session=' + token };
  }
  type Player = Awaited<ReturnType<typeof player>>;
  const post = (p: Player, path: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { ...headers, cookie: p.cookie },
      payload: JSON.stringify(payload),
    });
  async function funded(amountMinor = 2000) {
    const p = await player();
    const started = await post(p, '/wallet/v1/deposits', {
      operationId: randomUUID(),
      amountMinor,
    });
    assert.equal(started.statusCode, 201, started.body);
    const depositId = started.json<{ deposit: { id: string } }>().deposit.id;
    const body = JSON.stringify({
      id: 'evt_' + randomUUID(),
      type: 'deposit.succeeded',
      paymentId: depositId,
      providerReference: 'sbx_dep_' + depositId,
      amountMinor,
      currency: 'EUR',
    });
    const r = await app.inject({
      method: 'POST',
      url: '/wallet/v1/providers/sandbox/webhook',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-signature': signSandboxEvent(secret, body),
      },
      payload: body,
    });
    assert.deepEqual(r.json(), { status: 'processed' });
    return p;
  }
  async function available(p: Player) {
    const { rows } = await pool.query<{ amount: number }>(
      'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1',
      ['available:' + p.id],
    );
    return rows[0]!.amount;
  }
  async function start(p: Player, gameId: GameId) {
    const r = await post(p, '/house/v1/matches', {
      operationId: randomUUID(),
      gameId,
      offerId,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json<HouseGameView>();
  }
  const act = (p: Player, view: HouseGameView, action: unknown) =>
    post(p, `/house/v1/matches/${view.match.id}/actions`, {
      operationId: randomUUID(),
      expectedRevision: view.game.revision,
      action,
    });

  /** The test player also picks legal moves from its own observation only. */
  async function playToEnd(
    p: Player,
    gameId: GameId,
    view: HouseGameView,
    maxMoves = 20_000,
  ) {
    let randomState = 12345;
    for (let moves = 0; view.match.status === 'active'; moves++) {
      if (moves === maxMoves) return view;
      assert.ok(moves < 20_000, `${gameId} did not finish`);
      const decision = HUMAN[gameId](view.game.observation as never, {
        strategy: 'random',
        randomState,
      });
      assert.ok(
        decision.ok,
        `${gameId}: player has no move in an active game (${JSON.stringify(decision)})`,
      );
      randomState = decision.value.nextRandomState ?? randomState;
      const r = await act(p, view, decision.value.action);
      assert.equal(r.statusCode, 201, r.body);
      view = r.json<HouseGameView>();
    }
    return view;
  }

  for (const gameId of [
    'xeri',
    'diloti',
    'koumkan',
    'thanasis',
    'biriba',
    'tichu',
  ] as const)
    void it(`plays a full ${gameId} match against bots and settles it once`, async () => {
      const p = await funded();
      const started = await start(p, gameId);
      assert.equal(started.match.status, 'active');
      assert.equal(started.game.seats[0]!.kind, 'player');
      assert.ok(started.game.seats.slice(1).every((s) => s.kind === 'bot'));
      assert.equal(await available(p), 1500);
      assert.ok(!JSON.stringify(started.game.observation).includes('"seed"'));

      const ended = await playToEnd(p, gameId, started);
      const expected = { won: 2300, lost: 1500, void: 2000 }[
        ended.match.status as 'won' | 'lost' | 'void'
      ];
      assert.equal(await available(p), expected, ended.match.status);
      const late = await act(p, ended, { type: 'next' });
      assert.equal(late.statusCode, 409);
      const history = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM house_game_events WHERE match_id=$1',
        [ended.match.id],
      );
      assert.equal(history.rows[0]!.count, ended.game.revision);
      const pot = await pool.query<{ amount: number }>(
        'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1',
        ['house_match:' + ended.match.id],
      );
      assert.equal(pot.rows[0]!.amount, 0);
    });

  // Random chess drives the strict engine's legality proofs into very slow
  // positions, so play an opening through the detached path, then forfeit.
  void it('plays chess against the bot through detached preparation', async () => {
    const p = await funded();
    const started = await start(p, 'chess');
    assert.equal(started.match.status, 'active');
    const view = await playToEnd(p, 'chess', started, 15);
    if (view.match.status === 'active') {
      // Each player move is answered by exactly one bot move.
      assert.equal(view.game.revision, started.game.revision + 30);
      const r = await post(p, `/house/v1/matches/${view.match.id}/forfeit`, {
        operationId: randomUUID(),
      });
      assert.equal(r.statusCode, 201, r.body);
      assert.equal(r.json<HouseGameView>().match.status, 'lost');
      assert.equal(await available(p), 1500);
    }
  });

  void it('replays commands by operation ID and rejects stale or changed ones', async () => {
    const p = await funded();
    const view = await start(p, 'xeri');
    const decision = HUMAN.xeri(view.game.observation as never, {
      strategy: 'random',
      randomState: 1,
    });
    assert.ok(decision.ok);
    const input = {
      operationId: randomUUID(),
      expectedRevision: view.game.revision,
      action: decision.value.action,
    };
    const path = `/house/v1/matches/${view.match.id}/actions`;
    const first = await post(p, path, input);
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual((await post(p, path, input)).json(), first.json());
    const changed = await post(p, path, {
      ...input,
      expectedRevision: input.expectedRevision + 1,
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json<{ code: string }>().code, 'operation_conflict');
    const stale = await post(p, path, { ...input, operationId: randomUUID() });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json<{ code: string }>().code, 'stale_game_revision');
    const illegal = await act(p, first.json<HouseGameView>(), {
      type: 'play',
      cardId: 'nope',
    });
    assert.equal(illegal.statusCode, 400);
  });

  void it('forfeits as a loss and keeps other players out of the match', async () => {
    const p = await funded();
    const view = await start(p, 'diloti');
    const intruder = await funded();
    const peek = await app.inject({
      method: 'GET',
      url: `/house/v1/matches/${view.match.id}`,
      headers: { cookie: intruder.cookie },
    });
    assert.equal(peek.statusCode, 404);
    const r = await post(p, `/house/v1/matches/${view.match.id}/forfeit`, {
      operationId: randomUUID(),
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json<HouseGameView>().match.status, 'lost');
    assert.equal(await available(p), 1500);
    const again = await post(p, `/house/v1/matches/${view.match.id}/forfeit`, {
      operationId: randomUUID(),
    });
    assert.equal(again.statusCode, 409);
  });

  void it('refuses ineligible players, unknown offers and a second active match', async () => {
    const unverified = await post(await player(false), '/house/v1/matches', {
      operationId: randomUUID(),
      gameId: 'xeri',
      offerId,
    });
    assert.equal(unverified.statusCode, 403);
    const p = await funded();
    const unknown = await post(p, '/house/v1/matches', {
      operationId: randomUUID(),
      gameId: 'xeri',
      offerId: 'no-such-offer',
    });
    assert.equal(unknown.statusCode, 409);
    await start(p, 'xeri');
    const second = await post(p, '/house/v1/matches', {
      operationId: randomUUID(),
      gameId: 'chess',
      offerId,
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json<{ code: string }>().code, 'house_match_active');
    const offers = await app.inject({
      method: 'GET',
      url: '/house/v1/offers',
      headers: { cookie: p.cookie },
    });
    assert.deepEqual(offers.json(), {
      currency: 'EUR',
      offers: [{ id: offerId, stakeMinor: 500, prizeMinor: 800 }],
    });
  });
});
