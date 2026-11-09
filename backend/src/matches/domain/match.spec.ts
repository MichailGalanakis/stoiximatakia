import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Match, type RecordInitialResult } from './match';

const originalResult: RecordInitialResult = {
  operationId: 'result-1',
  winnerId: 'alice',
  recordedBy: 'trusted-reviewer',
  recordedAt: '2026-10-30T12:00:00.000Z',
};

void describe('Match domain', () => {
  void it('starts awaiting a result and rejects invalid match identities', () => {
    const match = new Match('match-1', ['alice', 'bob']);
    assert.equal(match.status, 'awaiting_result');
    assert.equal(match.version, 0);
    assert.deepEqual(match.toSnapshot().results, []);

    for (const create of [
      () => new Match('', ['alice', 'bob']),
      () => new Match('match-1', ['alice', 'alice']),
      () => new Match('match-1', ['alice', ' ']),
    ]) {
      assert.throws(create, { code: 'invalid_match' });
    }
  });

  void it('records one participant winner with immutable original provenance', () => {
    const participants: [string, string] = ['alice', 'bob'];
    const input = { ...originalResult };
    const match = new Match('match-1', participants);
    participants[0] = 'outsider';

    assert.equal(match.recordResult(input), true);
    input.winnerId = 'bob';
    const snapshot = match.toSnapshot();

    assert.equal(match.status, 'result_recorded');
    assert.equal(match.version, 1);
    assert.deepEqual(snapshot.participantIds, ['alice', 'bob']);
    assert.deepEqual(snapshot.results, [
      { kind: 'initial', ...originalResult },
    ]);
    assert.equal(Reflect.set(snapshot.results[0]!, 'winnerId', 'bob'), false);
    assert.equal(Reflect.set(snapshot.results, 'length', 0), false);
    assert.equal(match.toSnapshot().results[0]?.winnerId, 'alice');
  });

  void it('rejects invalid result data without changing state', () => {
    for (const input of [
      { ...originalResult, winnerId: 'outsider' },
      { ...originalResult, recordedBy: ' ' },
      { ...originalResult, operationId: '' },
      { ...originalResult, recordedAt: 'not-a-date' },
      { ...originalResult, recordedAt: '2026-02-30T12:00:00.000Z' },
    ]) {
      const match = new Match('match-1', ['alice', 'bob']);
      assert.throws(() => match.recordResult(input), {
        code: 'invalid_result',
      });
      assert.equal(match.status, 'awaiting_result');
      assert.equal(match.version, 0);
    }
  });

  void it('treats an exact retry as a no-op and retains the original timestamp', () => {
    const match = new Match('match-1', ['alice', 'bob']);
    match.recordResult(originalResult);

    assert.equal(
      match.recordResult({
        ...originalResult,
        recordedAt: '2026-10-31T12:00:00.000Z',
      }),
      false,
    );
    assert.equal(match.version, 1);
    assert.equal(
      match.toSnapshot().results[0]?.recordedAt,
      originalResult.recordedAt,
    );
  });

  void it('rejects reuse of an operation ID for a different winner or actor', () => {
    for (const input of [
      { ...originalResult, winnerId: 'bob' },
      { ...originalResult, recordedBy: 'another-reviewer' },
    ]) {
      const match = new Match('match-1', ['alice', 'bob']);
      match.recordResult(originalResult);
      assert.throws(() => match.recordResult(input), {
        code: 'operation_conflict',
      });
      assert.deepEqual(match.toSnapshot().results, [
        { kind: 'initial', ...originalResult },
      ]);
    }
  });

  void it('rejects a second recording operation even when its winner is unchanged', () => {
    const match = new Match('match-1', ['alice', 'bob']);
    match.recordResult(originalResult);
    assert.throws(
      () => match.recordResult({ ...originalResult, operationId: 'result-2' }),
      { code: 'result_already_recorded' },
    );
    assert.equal(match.version, 1);
  });

  void it('restores state through its invariants and rejects inconsistent snapshots', () => {
    const original = new Match('match-1', ['alice', 'bob']);
    original.recordResult(originalResult);
    const snapshot = original.toSnapshot();
    const restored = Match.fromSnapshot(snapshot);

    assert.deepEqual(restored.toSnapshot(), snapshot);
    assert.equal(restored.status, 'result_recorded');
    assert.throws(() => Match.fromSnapshot({ ...snapshot, version: 0 }), {
      code: 'invalid_match',
    });
    assert.throws(
      () =>
        Match.fromSnapshot({
          ...snapshot,
          results: [...snapshot.results, ...snapshot.results],
        }),
      { code: 'invalid_match' },
    );
    assert.throws(
      () =>
        Match.fromSnapshot({
          ...snapshot,
          results: [
            { kind: 'initial', ...originalResult, winnerId: 'outsider' },
          ],
        }),
      { code: 'invalid_result' },
    );
  });
});
