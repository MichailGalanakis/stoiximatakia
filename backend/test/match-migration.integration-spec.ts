import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { Pool } from 'pg';
import { postCredits } from '../src/credits/credit-ledger';

void it('upgrades an existing funded initialization-only game without changing money or inventing moves', async () => {
  const target = new URL(process.env.TEST_DATABASE_URL ?? '');
  assert.match(target.pathname, /_test$/);
  const schema = 'match_upgrade_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: target.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  target.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: target.href });
  try {
    for (const f of (await readdir('migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f) && f < '008_')
      .sort())
      await pool.query(await readFile('migrations/' + f, 'utf8'));
    const tableId = randomUUID(),
      users = [randomUUID(), randomUUID()],
      tickets = [randomUUID(), randomUUID()];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const id of users)
        await c.query(
          `INSERT INTO users(id,username,username_key,password_hash,email,phone,account_kind,terms_version,terms_accepted_at) VALUES($1,$2,$2,'isolated-test',$3,$4,'demo',null,null)`,
          [
            id,
            'M_' + id.replaceAll('-', '').slice(0, 20),
            id + '@demo.invalid',
            'demo:' + id,
          ],
        );
      await c.query(
        "INSERT INTO game_tables(id,creator_id,game_id,name,visibility,format_id,capacity,entry_fee_minor,contribution_minor) VALUES($1,$2,'chess','Existing test game','public','standard',2,90,500)",
        [tableId, users[0]],
      );
      for (let seat = 0; seat < 2; seat++) {
        const user = users[seat]!,
          ticket = tickets[seat]!;
        await c.query(
          'INSERT INTO table_tickets(id,table_id,user_id,fee_minor,contribution_minor) VALUES($1,$2,$3,90,500)',
          [ticket, tableId, user],
        );
        await c.query(
          'INSERT INTO table_participations(user_id,table_id,seat_index,ticket_id,ready) VALUES($1,$2,$3,$4,true)',
          [user, tableId, seat, ticket],
        );
        await postCredits(c, {
          operationKey: 'reserve:' + ticket,
          kind: 'reserve',
          referenceId: ticket,
          actorId: user,
          postings: [
            { account: 'available:' + user, amount: -590 },
            { account: 'reserved:' + user, amount: 590 },
          ],
        });
      }
      await c.query(
        "INSERT INTO table_games(table_id,rules_version,state) VALUES($1,'old-initializer','{\"turn\":0}')",
        [tableId],
      );
      await c.query("INSERT INTO credit_accounts(key,kind) VALUES($1,'pool')", [
        'pool:' + tableId,
      ]);
      await postCredits(c, {
        operationKey: 'start:' + tableId,
        kind: 'start',
        referenceId: tableId,
        postings: [
          ...users.map((user) => ({
            account: 'reserved:' + user,
            amount: -590,
          })),
          { account: 'pool:' + tableId, amount: 1000 },
          { account: 'fees', amount: 180 },
        ],
      });
      await c.query(
        "UPDATE table_tickets SET state='committed' WHERE table_id=$1",
        [tableId],
      );
      await c.query(
        "UPDATE game_tables SET status='playing',started_at=now() WHERE id=$1",
        [tableId],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const balances = await pool.query<{ key: string; balance_minor: string }>(
      'SELECT key,balance_minor FROM credit_accounts ORDER BY key',
    );
    const journalCount = (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM credit_journals',
      )
    ).rows[0]!.n;
    await pool.query(
      await readFile('migrations/008_match_lifecycle.sql', 'utf8'),
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT key,balance_minor FROM credit_accounts ORDER BY key',
        )
      ).rows,
      balances.rows,
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM credit_journals',
        )
      ).rows[0]!.n,
      journalCount,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM match_roster WHERE table_id=$1', [
          tableId,
        ])
      ).rowCount,
      2,
    );
    assert.equal((await pool.query('SELECT 1 FROM match_results')).rowCount, 0);
    const game = (
      await pool.query<{
        engine_version: string;
        accepted_gameplay_count: number;
        revision: number;
      }>('SELECT * FROM table_games WHERE table_id=$1', [tableId])
    ).rows[0]!;
    assert.equal(game.engine_version, 'initialization-only');
    assert.equal(game.accepted_gameplay_count, 0);
    assert.equal(game.revision, 1);
    const root = (
      await pool.query<{ payload: { initialState: unknown; source: string } }>(
        'SELECT payload FROM match_events WHERE table_id=$1',
        [tableId],
      )
    ).rows[0]!.payload;
    assert.deepEqual(root.initialState, { turn: 0 });
    assert.equal(root.source, 'migration-008');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
