// Deliberately hard-coded reserved test hostname; never run mutations on the live site.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const WebSocket = createRequire('/app/package.json')('ws');
const { Pool } = createRequire('/app/package.json')('pg');
const chess = createRequire('/app/package.json')('#engines/chess');
const origin = 'https://skillbetting.test';
assert.equal(process.env.SMOKE_TEST_ALLOWED, 'isolated-compose');
assert.equal(process.env.APP_ORIGIN, origin);
const target = new URL(process.env.DATABASE_URL);
assert.equal(target.hostname, 'postgres');
assert.equal(target.pathname, '/skillbetting');
assert.equal(target.username, 'skillbetting_app');
async function withDatabase(run) {
  const database = new Pool({
    connectionString: target.href,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  try {
    return await run(database);
  } finally {
    await database.end();
  }
}
await withDatabase(async (database) => {
  assert.equal(
    (await database.query('SELECT current_user')).rows[0].current_user,
    'skillbetting_app',
  );
  for (const sql of [
    'CREATE TABLE release_permission_probe(id integer)',
    'UPDATE schema_migrations SET sha256=sha256 WHERE false',
  ]) {
    await assert.rejects(
      database.query(sql),
      (error) => error.code === '42501',
    );
  }
});
const headers = {
  Origin: origin,
  'X-SkillBetting-Client': 'web-v1',
  'Content-Type': 'application/json',
};
async function request(
  path,
  cookie,
  body,
  expected = body === undefined ? 200 : 201,
  coldRepair = false,
) {
  assert.ok(!coldRepair || body === undefined);
  for (let attempt = 0; attempt < (coldRepair ? 100 : 1); attempt++) {
    const response = await fetch(origin + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const value = await response.json();
    if (
      coldRepair &&
      response.status === 503 &&
      value.code === 'platform_unavailable'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    assert.equal(response.status, expected, `Unexpected status for ${path}`);
    return { response, value };
  }
  throw new Error(
    'Cold chess observation did not repair within the smoke retry budget',
  );
}
function chessView(room, userId, color) {
  assert.deepEqual(Object.keys(room.game).sort(), [
    'engineVersion',
    'observation',
    'revision',
    'rulesVersion',
    'status',
  ]);
  assert.equal(room.game.engineVersion, chess.ARTIFACT_ENGINE_VERSION);
  assert.equal(room.game.rulesVersion, chess.ARTIFACT_RULES_VERSION);
  const observation = room.game.observation;
  assert.deepEqual(Object.keys(observation).sort(), [
    'analysisRoot',
    'awaitingResignationDecision',
    'conformance',
    'drawOffer',
    'fen',
    'forcedMove',
    'game',
    'inCheck',
    'legalActions',
    'matchOutcome',
    'moves',
    'phase',
    'players',
    'ply',
    'revision',
    'roundOutcome',
    'rulesVersion',
    'turn',
    'viewer',
    'viewerColor',
  ]);
  assert.equal(observation.game, 'chess');
  assert.equal(observation.rulesVersion, chess.ARTIFACT_RULES_VERSION);
  assert.equal(observation.viewer, userId);
  assert.equal(observation.viewerColor, color);
  assert.equal(observation.analysisRoot, false);
  assert.equal(observation.awaitingResignationDecision, false);
  assert.equal(
    observation.conformance.automaticDeadPositionDetection,
    'required-verified-evidence',
  );
  assert.equal(observation.conformance.unprovedContinuation, false);
  assert.ok(
    observation.legalActions.every(
      (action) =>
        !['resign', 'dead-position', 'adjudicate'].includes(action.type),
    ),
  );
}
const chessRoom = async (id, cookie) =>
  (
    await request(
      `/multiplayer/v1/tables/${id}/game`,
      cookie,
      undefined,
      200,
      true,
    )
  ).value;
async function chessStored(id, plies) {
  return withDatabase(async (database) => {
    const row = (
      await database.query(
        'SELECT engine_version,rules_version,state FROM table_games WHERE table_id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(row.engine_version, chess.ARTIFACT_ENGINE_VERSION);
    assert.equal(row.rules_version, chess.ARTIFACT_RULES_VERSION);
    assert.equal(row.state.schemaVersion, 3);
    assert.equal(row.state.initial.mode, 'standard');
    assert.equal(row.state.ply, plies);
    assert.equal(row.state.decisions.length, plies + 1);
    const refs = (
      await database.query(
        "SELECT decision_revision,encode(artifact_id,'hex') AS artifact_id,root_key,kernel_engine,kernel_rules,format FROM match_chess_proof_refs WHERE table_id=$1 ORDER BY decision_revision",
        [id],
      )
    ).rows;
    assert.equal(refs.length, plies + 1);
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index],
        receipt = row.state.decisions[index];
      assert.deepEqual(Object.keys(receipt).sort(), [
        'artifactId',
        'format',
        'kernelEngineVersion',
        'kernelRulesVersion',
        'revision',
        'root',
      ]);
      assert.deepEqual(receipt, {
        revision: ref.decision_revision,
        artifactId: ref.artifact_id,
        root: ref.root_key,
        kernelEngineVersion: ref.kernel_engine,
        kernelRulesVersion: ref.kernel_rules,
        format: ref.format,
      });
    }
    const artifacts = (
      await database.query(
        "SELECT encode(a.manifest_digest,'hex') AS id,a.work_id,(SELECT count(*)::text FROM chess_proof_check_runs c WHERE c.work_id=a.work_id AND c.stage='complete') AS checks FROM chess_proof_artifacts a WHERE a.manifest_digest IN (SELECT artifact_id FROM match_chess_proof_refs WHERE table_id=$1) ORDER BY a.manifest_digest",
        [id],
      )
    ).rows;
    assert.deepEqual(
      (await database.query('SELECT * FROM chess_proof_integrity_errors()'))
        .rows,
      [],
    );
    return { ...row, artifacts };
  });
}
async function chessMove(id, cookie, room, from, to) {
  const command = {
      operationId: randomUUID(),
      expectedRevision: room.game.revision,
      action: { type: 'move', from, to },
    },
    result = (
      await request(`/multiplayer/v1/tables/${id}/actions`, cookie, command)
    ).value;
  assert.deepEqual(
    (await request(`/multiplayer/v1/tables/${id}/actions`, cookie, command))
      .value,
    result,
  );
  return { command, result };
}
async function resumeRestoredChess() {
  const restored = await withDatabase(async (database) => {
    const tables = (
      await database.query(
        "SELECT id FROM game_tables WHERE game_id='chess' AND status='playing' AND name='Disposable container chess verification'",
      )
    ).rows;
    assert.ok(tables.length <= 1);
    if (!tables.length) return null;
    const id = tables[0].id,
      users = (
        await database.query(
          'SELECT u.id,u.account_kind,u.email,u.phone,u.email_verified,u.phone_verified,r.seat_index FROM match_roster r JOIN users u ON u.id=r.user_id WHERE r.table_id=$1 ORDER BY r.seat_index',
          [id],
        )
      ).rows;
    assert.equal(
      (await database.query('SELECT count(*)::text AS count FROM users'))
        .rows[0].count,
      '2',
    );
    assert.equal(users.length, 2);
    const cookies = [];
    for (const [seat, user] of users.entries()) {
      assert.equal(user.seat_index, seat);
      assert.equal(user.account_kind, 'demo');
      assert.equal(user.email, user.id + '@demo.invalid');
      assert.equal(user.phone, 'demo:' + user.id);
      assert.equal(user.email_verified, false);
      assert.equal(user.phone_verified, false);
      // Isolated smoke recovery only: no app route, delivery or extra users.
      const token = randomBytes(32).toString('hex');
      await database.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [createHash('sha256').update(token).digest('hex'), user.id],
      );
      cookies.push('__Host-sb_session=' + token);
    }
    return { id, users, cookies };
  });
  if (!restored) return { resumed: false };
  const { id, users, cookies } = restored,
    before = await chessStored(id, 2);
  assert.deepEqual(
    before.state.history.map((entry) => entry.action),
    [
      { type: 'move', from: 'f2', to: 'f3' },
      { type: 'move', from: 'e7', to: 'e5' },
    ],
  );
  let room = await chessRoom(id, cookies[0]);
  chessView(room, users[0].id, 'white');
  assert.deepEqual(
    room.game.observation.moves.map((move) => move.san),
    ['f3', 'e5'],
  );
  const after = await chessStored(id, 2);
  assert.deepEqual(
    after.artifacts.map((a) => a.id),
    before.artifacts.map((a) => a.id),
  );
  for (let index = 0; index < before.artifacts.length; index++)
    assert.ok(
      BigInt(after.artifacts[index].checks) >
        BigInt(before.artifacts[index].checks),
      'Cold restore must mathematically recheck every old artifact',
    );
  room = (await chessMove(id, cookies[0], room, 'g2', 'g4')).result;
  const terminal = await chessMove(id, cookies[1], room, 'd8', 'h4');
  assert.equal(
    terminal.result.game.observation.matchOutcome.gameReason,
    'checkmate',
  );
  assert.equal(terminal.result.game.observation.moves.at(-1).san, 'Qh4#');
  assert.equal(terminal.result.game.status, 'completed');
  await chessStored(id, 4);
  const balances = await Promise.all(
    cookies.map(
      async (cookie) =>
        (await request('/multiplayer/v1/credits', cookie)).value.balance,
    ),
  );
  assert.deepEqual(balances, [
    { availableMinor: 24620, reservedMinor: 0 },
    { availableMinor: 25020, reservedMinor: 0 },
  ]);
  return {
    resumed: true,
    oldArtifactsColdVerified: before.artifacts.length,
    proofArtifactsPreserved: true,
    exactTerminalRetry: true,
    balances,
  };
}
const live = await fetch(origin + '/api/health/ready');
assert.equal(live.status, 200);
assert.equal((await fetch(origin)).status, 200);
for (const path of [
  '/preview/full-ui',
  '/preview/header',
  '/api/qa/player',
  '/reference/',
  '/.env',
])
  assert.equal((await fetch(origin + path)).status, 404);
const restoredChess = await resumeRestoredChess();
const players = [];
const playerIds = [];
for (let i = 0; i < 2; i++) {
  const { response, value } = await request('/auth/demo', undefined, {}, 200);
  assert.equal(value.account.kind, 'demo');
  const session = response.headers
    .getSetCookie()
    .find((c) => c.startsWith('__Host-sb_session='));
  assert.ok(
    session &&
      /; Secure(?:;|$)/i.test(session) &&
      /; HttpOnly(?:;|$)/i.test(session),
  );
  players.push(session.split(';')[0]);
  playerIds.push(value.account.id);
}
const beforeDisabled = (await request('/multiplayer/v1/credits', players[0]))
  .value.balance;
await request(
  '/multiplayer/v1/tables',
  players[0],
  {
    operationId: randomUUID(),
    gameId: 'invalid-game',
    name: 'Invalid game must not reserve funds',
    visibility: 'public',
    formatId: 'standard',
    prizeContributionMinor: 100,
  },
  400,
);
assert.deepEqual(
  (await request('/multiplayer/v1/credits', players[0])).value.balance,
  beforeDisabled,
);
const create = await request(
  '/multiplayer/v1/tables',
  players[0],
  {
    operationId: randomUUID(),
    gameId: 'xeri',
    name: 'Disposable container verification',
    visibility: 'private',
    accessCode: 'ContainerQA7',
    formatId: 'standard',
    prizeContributionMinor: 100,
  },
  201,
);
const id = create.value.table.id;
assert.equal(
  (await request('/multiplayer/v1/tables?gameId=xeri', players[1])).value.tables
    .length,
  0,
);
await request(
  '/multiplayer/v1/private-access',
  players[1],
  { code: 'containerqa7' },
  404,
);
await request('/multiplayer/v1/private-access', players[1], {
  code: 'ContainerQA7',
});
await request(`/multiplayer/v1/tables/${id}/seats`, players[1], {
  operationId: randomUUID(),
  seatIndex: 1,
});
for (const cookie of players)
  await request(`/multiplayer/v1/tables/${id}/ready`, cookie, {
    operationId: randomUUID(),
  });
const games = await Promise.all(
  players.map(
    async (cookie) =>
      (await request(`/multiplayer/v1/tables/${id}/game`, cookie)).value,
  ),
);
assert.notDeepEqual(
  games[0].game.observation.hand,
  games[1].game.observation.hand,
);
assert.ok(
  games.every(
    (g) => !('seed' in g.game.observation) && !('hands' in g.game.observation),
  ),
);
await new Promise((resolve, reject) => {
  const socket = new WebSocket(
    origin.replace('https:', 'wss:') + '/api/multiplayer/v1/live',
    {
      headers: { Cookie: players[0], Origin: origin },
    },
  );
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error('Websocket proxy verification timed out'));
  }, 10000);
  socket.on('error', reject);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'connected')
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          id: randomUUID(),
          gameId: 'xeri',
          tableId: id,
        }),
      );
    if (message.type === 'snapshot') {
      clearTimeout(timer);
      socket.close();
      resolve();
    }
    if (message.type === 'error') {
      clearTimeout(timer);
      socket.close();
      reject(new Error('Websocket subscription rejected'));
    }
  });
});
const actor = games.findIndex(
  (g) => g.game.observation.turn === g.game.observation.viewerSeat,
);
assert.ok(actor >= 0);
const action = games[actor].game.observation.legalActions[0];
assert.ok(action);
const command = {
  operationId: randomUUID(),
  expectedRevision: games[actor].game.revision,
  action,
};
const first = (
  await request(`/multiplayer/v1/tables/${id}/actions`, players[actor], command)
).value;
assert.deepEqual(
  (
    await request(
      `/multiplayer/v1/tables/${id}/actions`,
      players[actor],
      command,
    )
  ).value,
  first,
);
const current = (await request(`/multiplayer/v1/tables/${id}/game`, players[0]))
  .value;
const forfeit = {
  operationId: randomUUID(),
  expectedRevision: current.game.revision,
};
const final = (
  await request(`/multiplayer/v1/tables/${id}/forfeit`, players[0], forfeit)
).value;
assert.deepEqual(
  (await request(`/multiplayer/v1/tables/${id}/forfeit`, players[0], forfeit))
    .value,
  final,
);
const balances = await Promise.all(
  players.map(
    async (cookie) =>
      (await request('/multiplayer/v1/credits', cookie)).value.balance,
  ),
);
assert.deepEqual(balances, [
  { availableMinor: 24810, reservedMinor: 0 },
  { availableMinor: 25010, reservedMinor: 0 },
]);
const chessCreate = (
  await request('/multiplayer/v1/tables', players[0], {
    operationId: randomUUID(),
    gameId: 'chess',
    name: 'Disposable container chess verification',
    visibility: 'private',
    accessCode: 'ContainerChess7',
    formatId: 'standard',
    prizeContributionMinor: 100,
  })
).value;
const chessId = chessCreate.table.id;
await request('/multiplayer/v1/private-access', players[1], {
  code: 'ContainerChess7',
});
await request(`/multiplayer/v1/tables/${chessId}/seats`, players[1], {
  operationId: randomUUID(),
  seatIndex: 1,
});
for (const cookie of players)
  await request(`/multiplayer/v1/tables/${chessId}/ready`, cookie, {
    operationId: randomUUID(),
  });
let chessCurrent = await chessRoom(chessId, players[0]);
for (let seat = 0; seat < 2; seat++)
  chessView(
    await chessRoom(chessId, players[seat]),
    playerIds[seat],
    seat === 0 ? 'white' : 'black',
  );
assert.equal(chessCurrent.game.observation.ply, 0);
const f3 = await chessMove(chessId, players[0], chessCurrent, 'f2', 'f3');
chessCurrent = (await chessMove(chessId, players[1], f3.result, 'e7', 'e5'))
  .result;
assert.deepEqual(
  (
    await request(
      `/multiplayer/v1/tables/${chessId}/actions`,
      players[0],
      f3.command,
    )
  ).value,
  f3.result,
);
assert.equal(chessCurrent.game.status, 'playing');
assert.deepEqual(
  chessCurrent.game.observation.moves.map((move) => move.san),
  ['f3', 'e5'],
);
const checkpoint = await chessStored(chessId, 2);
await withDatabase(async (database) => {
  // The release grants table DML to the app role. Immutable evidence must
  // remain protected by triggers even under those actual container grants.
  for (const [sql, values] of [
    [
      'UPDATE chess_proof_chunks SET payload=payload WHERE work_id=$1',
      [checkpoint.artifacts[0].work_id],
    ],
    [
      'UPDATE chess_proof_artifacts SET manifest=manifest WHERE work_id=$1',
      [checkpoint.artifacts[0].work_id],
    ],
    [
      'UPDATE match_chess_proof_refs SET root_key=root_key WHERE table_id=$1',
      [chessId],
    ],
  ])
    await assert.rejects(
      database.query(sql, values),
      (error) => error.code === '23514',
    );
  await assert.rejects(
    database.query('ALTER TABLE chess_proof_chunks DISABLE TRIGGER USER'),
    (error) => error.code === '42501',
  );
});
const chessBalances = await Promise.all(
  players.map(
    async (cookie) =>
      (await request('/multiplayer/v1/credits', cookie)).value.balance,
  ),
);
assert.deepEqual(chessBalances, [
  { availableMinor: 24620, reservedMinor: 0 },
  { availableMinor: 24820, reservedMinor: 0 },
]);
console.log(
  JSON.stringify({
    status: 'passed',
    https: true,
    secureCookies: true,
    privateTable: true,
    ownHandsOnly: true,
    invalidGameBlockedWithoutFunds: true,
    databaseLeastPrivilege: true,
    websocketUpgrade: true,
    legalMoveRetry: true,
    settlementRetry: true,
    balances,
    chess: {
      engineVersion: chess.ARTIFACT_ENGINE_VERSION,
      schemaVersion: 3,
      standardStart: true,
      privateViews: true,
      exactMoveRetry: true,
      playingPlies: 2,
      artifactRefs: checkpoint.state.decisions.length,
      artifacts: checkpoint.artifacts.length,
      proofRowsImmutable: true,
      balances: chessBalances,
    },
    restoredChess,
    resultIdHash: createHash('sha256')
      .update(final.match.outcome.id)
      .digest('hex'),
  }),
);
