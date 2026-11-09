import { Test } from '@nestjs/testing';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { InMemoryMatchRepository } from '../../../test/support/in-memory-match.repository';
import { Match } from '../domain/match';
import {
  MATCH_REPOSITORY,
  MatchConcurrencyError,
  type MatchRepository,
} from './match.repository';
import {
  MatchNotFoundError,
  RecordMatchResultService,
  type RecordMatchResultInput,
} from './record-match-result.service';

const input: RecordMatchResultInput = {
  matchId: 'match-1',
  operationId: 'result-1',
  winnerId: 'alice',
  actorId: 'trusted-reviewer',
};

void describe('RecordMatchResultService', () => {
  void it('resolves a repository through Nest DI and persists the domain transition', async (context) => {
    const repository = new InMemoryMatchRepository([
      new Match('match-1', ['alice', 'bob']),
    ]);
    const module = await Test.createTestingModule({
      providers: [
        RecordMatchResultService,
        { provide: MATCH_REPOSITORY, useValue: repository },
      ],
    }).compile();
    context.after(() => module.close());

    const result = await module.get(RecordMatchResultService).execute(input);

    assert.equal(result.version, 1);
    assert.equal(result.results[0]?.winnerId, 'alice');
    assert.equal(result.results[0]?.recordedBy, input.actorId);
    assert.equal(
      Number.isFinite(Date.parse(result.results[0].recordedAt)),
      true,
    );
    assert.deepEqual(
      (await repository.findById('match-1'))?.toSnapshot(),
      result,
    );
  });

  void it('reports a missing match', async () => {
    const service = new RecordMatchResultService(new InMemoryMatchRepository());
    await assert.rejects(service.execute(input), MatchNotFoundError);
  });

  void it('skips persistence on an idempotent retry and retains the original record', async () => {
    const stored = new InMemoryMatchRepository([
      new Match('match-1', ['alice', 'bob']),
    ]);
    const savedVersions: number[] = [];
    const repository: MatchRepository = {
      findById: (id) => stored.findById(id),
      save: (match, expectedVersion) => {
        savedVersions.push(expectedVersion);
        return stored.save(match, expectedVersion);
      },
    };
    const service = new RecordMatchResultService(repository);

    const first = await service.execute(input);
    const retry = await service.execute(input);

    assert.deepEqual(retry, first);
    assert.deepEqual(savedVersions, [0]);
    await assert.rejects(service.execute({ ...input, winnerId: 'bob' }), {
      code: 'operation_conflict',
    });
    assert.deepEqual((await stored.findById('match-1'))?.toSnapshot(), first);
  });

  void it('does not persist a rejected domain operation', async () => {
    const repository = new InMemoryMatchRepository([
      new Match('match-1', ['alice', 'bob']),
    ]);
    const service = new RecordMatchResultService(repository);

    await assert.rejects(service.execute({ ...input, winnerId: 'outsider' }), {
      code: 'invalid_result',
    });
    assert.equal((await repository.findById('match-1'))?.version, 0);
  });

  void it('preserves one result when concurrent recordings race and allows the winning retry', async () => {
    const repository = new InMemoryMatchRepository([
      new Match('match-1', ['alice', 'bob']),
    ]);
    const service = new RecordMatchResultService(repository);
    const attempts = [
      input,
      { ...input, operationId: 'result-2', winnerId: 'bob' },
    ];

    const results = await Promise.allSettled(
      attempts.map((attempt) => service.execute(attempt)),
    );
    const succeededIndex = results.findIndex(
      (result) => result.status === 'fulfilled',
    );
    const failure = results.find((result) => result.status === 'rejected');

    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.ok(failure?.status === 'rejected');
    assert.ok(failure.reason instanceof MatchConcurrencyError);
    const stored = (await repository.findById('match-1'))!.toSnapshot();
    assert.equal(stored.results.length, 1);
    assert.equal(stored.version, 1);
    assert.deepEqual(await service.execute(attempts[succeededIndex]!), stored);
  });

  void it('does not leak unsaved aggregate changes through the repository', async () => {
    const repository = new InMemoryMatchRepository([
      new Match('match-1', ['alice', 'bob']),
    ]);
    const loaded = (await repository.findById('match-1'))!;
    loaded.recordResult({
      operationId: input.operationId,
      winnerId: input.winnerId,
      recordedBy: input.actorId,
      recordedAt: '2026-10-30T12:00:00.000Z',
    });

    assert.equal((await repository.findById('match-1'))?.version, 0);
    await repository.save(loaded, 0);
    await assert.rejects(repository.save(loaded, 0), MatchConcurrencyError);
    await assert.rejects(
      repository.save(new Match('match-1', ['alice', 'bob']), 1),
      MatchConcurrencyError,
    );
    assert.equal((await repository.findById('match-1'))?.version, 1);
  });

  void it('propagates persistence failures without reporting success', async () => {
    const failure = new Error('storage unavailable');
    const repository: MatchRepository = {
      findById: () => Promise.resolve(new Match('match-1', ['alice', 'bob'])),
      save: () => Promise.reject(failure),
    };

    await assert.rejects(
      new RecordMatchResultService(repository).execute(input),
      failure,
    );
  });
});
