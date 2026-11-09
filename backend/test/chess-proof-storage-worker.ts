// Isolated test worker: mathematical verification/publication never runs on HTTP's thread.
import { parentPort, workerData } from 'node:worker_threads';
import { Pool } from 'pg';
import * as chess from '#engines/chess';
import { ChessProofRepository } from '../src/tables/chess-proof-repository';

interface Job {
  url: string;
  workId: string;
  fen: string;
  artifactId?: string;
  solve?: boolean;
  forceProbeBudgetStop?: boolean;
}
const job = workerData as Job;
async function main() {
  const pool = new Pool({ connectionString: job.url }),
    repository = new ChessProofRepository(pool);
  const originalMemoryUsage = process.memoryUsage;
  let budgetStopObserved = false;
  if (job.forceProbeBudgetStop)
    process.memoryUsage = Object.assign(
      () => {
        budgetStopObserved = true;
        return { ...originalMemoryUsage(), heapUsed: Number.MAX_SAFE_INTEGER };
      },
      { rss: () => originalMemoryUsage.rss() },
    );
  try {
    const built = job.solve
      ? await repository.solveAndBind(
          job.fen,
          job.forceProbeBudgetStop
            ? {
                signal: {
                  get aborted() {
                    return budgetStopObserved;
                  },
                },
              }
            : {},
        )
      : null;
    const artifactId = job.artifactId ?? built?.artifactId;
    const token = artifactId
      ? await repository.verifyArtifact(artifactId, job.fen)
      : await repository.verifySealed(job.workId, job.fen);
    let cloneRejected = false,
      foreignRejected = false;
    try {
      await repository.publishChecked(
        JSON.parse(JSON.stringify(token)) as unknown,
      );
    } catch {
      cloneRejected = true;
    }
    try {
      await new ChessProofRepository(pool).publishChecked(token);
    } catch {
      foreignRejected = true;
    }
    const descriptor = await repository.publishChecked(token),
      binding = await repository.checkedBinding(token);
    parentPort?.postMessage({
      ok: true,
      descriptor,
      summary: token,
      cloneRejected,
      foreignRejected,
      bindingAccepted: chess.bindVerifiedArtifact(token, descriptor).ok,
      bindingKeys: Object.keys(binding),
    });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      code:
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'unknown',
      budgetStopObserved,
    });
  } finally {
    process.memoryUsage = originalMemoryUsage;
    await pool.end();
    parentPort?.close();
  }
}
void main();
