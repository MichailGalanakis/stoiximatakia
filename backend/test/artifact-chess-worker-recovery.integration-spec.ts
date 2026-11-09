import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { before, after, describe, it } from 'node:test';
import { Pool } from 'pg';
import { ArtifactChessProofWorker } from '../src/tables/artifact-chess-proof-worker';

void describe('artifact proof worker interruption in isolated PostgreSQL', () => {
  const schema = 'proof_recovery_' + randomUUID().replaceAll('-', ''),
    participants = [
      { userId: 'alice', seat: 0 },
      { userId: 'bob', seat: 1 },
    ];
  let admin: Pool, pool: Pool, url: string;
  const workers = new Set<ArtifactChessProofWorker>();
  before(async () => {
    const target = new URL(process.env.TEST_DATABASE_URL ?? '');
    assert.match(target.pathname, /_test$/);
    admin = new Pool({ connectionString: target.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    target.searchParams.set('application_name', schema + '_worker');
    url = target.href;
    pool = new Pool({ connectionString: url });
    for (const file of (await readdir('migrations'))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort())
      await pool.query(await readFile('migrations/' + file, 'utf8'));
  });
  after(async () => {
    await Promise.all([...workers].map((worker) => worker.close()));
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  function worker() {
    const owned = new ArtifactChessProofWorker({ connectionString: url });
    workers.add(owned);
    return owned;
  }
  void it(
    'aborts without accepted state, resumes committed proof bytes and verifies cold refs in a new worker',
    { timeout: 20_000 },
    async () => {
      // This isolated test trigger exposes an otherwise very short durable export
      // checkpoint. It neither changes proof bytes nor supplies a verdict.
      await pool.query(`CREATE FUNCTION recovery_delay_seal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.stage='sealed' AND OLD.stage='exporting' THEN
        PERFORM pg_sleep(0.5);
      END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER recovery_delay_seal BEFORE UPDATE ON chess_proof_work
      FOR EACH ROW EXECUTE FUNCTION recovery_delay_seal()`);
      const interrupted = worker(),
        controller = new AbortController();
      const pending = interrupted.prepareInitial(participants, {
          signal: controller.signal,
        }),
        rejected = assert.rejects(pending, { code: 'proof_cancelled' });
      let workId = '';
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const checkpoint = (
            await pool.query<{ id: string }>(
              `SELECT id FROM chess_proof_work WHERE stage='exporting' AND chunk_count>0
           AND EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep')`,
              [schema + '_worker'],
            )
          ).rows[0];
          if (checkpoint) {
            workId = checkpoint.id;
            break;
          }
          await delay(10);
        }
        assert.notEqual(
          workId,
          '',
          'the real worker must commit proof chunks before interruption',
        );
        controller.abort();
        await rejected;
        assert.equal(interrupted.activeCount, 0);
        await interrupted.close();
      } finally {
        controller.abort();
        await interrupted.close();
        await pool.query(
          'DROP TRIGGER recovery_delay_seal ON chess_proof_work',
        );
        await pool.query('DROP FUNCTION recovery_delay_seal()');
      }
      const bytes = async () =>
        (
          await pool.query<{
            ordinal: string;
            payload: Buffer;
            digest: Buffer;
            chain_digest: Buffer;
          }>(
            'SELECT ordinal,payload,digest,chain_digest FROM chess_proof_chunks WHERE work_id=$1 ORDER BY ordinal',
            [workId],
          )
        ).rows;
      const committed = await bytes();
      assert.ok(committed.length > 0);
      assert.equal(
        (await pool.query('SELECT 1 FROM chess_proof_artifacts')).rowCount,
        0,
        'a cancelled export cannot publish an unchecked artifact',
      );
      const fresh = worker(),
        initial = await fresh.prepareInitial(participants);
      assert.equal(typeof initial.initial.state, 'object');
      assert.deepEqual(
        await bytes(),
        committed,
        'resume must preserve the exact committed chunk bytes and chain',
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM chess_proof_work')).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM chess_proof_work WHERE id=$1 AND stage='sealed'",
            [workId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM chess_proof_artifacts WHERE work_id=$1',
            [workId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM chess_proof_check_runs WHERE work_id=$1 AND stage='complete'",
            [workId],
          )
        ).rowCount,
        1,
      );
      await fresh.close();
      const cold = worker(),
        observed = await cold.observe({
          state: initial.initial.state,
          participants,
        });
      assert.deepEqual(observed.observations, initial.observations);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM chess_proof_check_runs WHERE work_id=$1 AND stage='complete'",
            [workId],
          )
        ).rowCount,
        2,
        'a new worker must independently verify streams instead of trusting durable metadata',
      );
      for (const entry of observed.observations) {
        assert.equal('decisions' in entry.observation, false);
        assert.equal('evidence' in entry.observation, false);
      }
      await cold.close();
    },
  );
});
