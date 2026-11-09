export type MatchStatus = 'awaiting_result' | 'result_recorded';

export interface MatchResultRecord {
  readonly kind: 'initial';
  readonly operationId: string;
  readonly winnerId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface MatchSnapshot {
  readonly id: string;
  readonly participantIds: readonly [string, string];
  readonly version: number;
  readonly results: readonly MatchResultRecord[];
}

export type MatchDomainErrorCode =
  | 'invalid_match'
  | 'invalid_result'
  | 'result_already_recorded'
  | 'operation_conflict';

export class MatchDomainError extends Error {
  constructor(
    readonly code: MatchDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MatchDomainError';
  }
}

export interface RecordInitialResult {
  readonly operationId: string;
  readonly winnerId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** A small PvP competition; recording a result does not authorize settlement. */
export class Match {
  private readonly participantIds: readonly [string, string];
  private readonly results: MatchResultRecord[] = [];

  constructor(
    readonly id: string,
    participantIds: readonly [string, string],
  ) {
    if (
      !hasText(id) ||
      participantIds.length !== 2 ||
      !participantIds.every(hasText) ||
      participantIds[0] === participantIds[1]
    ) {
      throw new MatchDomainError(
        'invalid_match',
        'A match needs an ID and two distinct participant IDs.',
      );
    }

    this.participantIds = Object.freeze([
      participantIds[0],
      participantIds[1],
    ] as const);
  }

  get status(): MatchStatus {
    return this.results.length === 0 ? 'awaiting_result' : 'result_recorded';
  }

  get version(): number {
    return this.results.length;
  }

  /** Returns false for an exact retry. A retry never replaces original provenance. */
  recordResult(input: RecordInitialResult): boolean {
    if (
      !hasText(input.operationId) ||
      !hasText(input.recordedBy) ||
      !this.participantIds.includes(input.winnerId) ||
      !isCanonicalTimestamp(input.recordedAt)
    ) {
      throw new MatchDomainError(
        'invalid_result',
        'A result needs an operation ID, actor, participant winner, and UTC timestamp.',
      );
    }

    const existing = this.results[0];
    if (existing) {
      if (existing.operationId === input.operationId) {
        if (
          existing.winnerId === input.winnerId &&
          existing.recordedBy === input.recordedBy
        ) {
          return false;
        }
        throw new MatchDomainError(
          'operation_conflict',
          'This operation ID has already recorded a different result or actor.',
        );
      }

      throw new MatchDomainError(
        'result_already_recorded',
        'An original result already exists; an authorized revision is required.',
      );
    }

    this.results.push(
      Object.freeze({
        kind: 'initial',
        operationId: input.operationId,
        winnerId: input.winnerId,
        recordedBy: input.recordedBy,
        recordedAt: input.recordedAt,
      }),
    );
    return true;
  }

  toSnapshot(): MatchSnapshot {
    return Object.freeze({
      id: this.id,
      participantIds: Object.freeze([
        this.participantIds[0],
        this.participantIds[1],
      ] as const),
      version: this.version,
      results: Object.freeze(
        this.results.map((result) => Object.freeze({ ...result })),
      ),
    });
  }

  /** Restore through the same invariants used for newly recorded results. */
  static fromSnapshot(snapshot: MatchSnapshot): Match {
    const match = new Match(snapshot.id, snapshot.participantIds);
    if (
      snapshot.results.length > 1 ||
      snapshot.version !== snapshot.results.length ||
      snapshot.results.some((result) => result.kind !== 'initial')
    ) {
      throw new MatchDomainError(
        'invalid_match',
        'The match snapshot is invalid.',
      );
    }
    for (const result of snapshot.results) {
      match.recordResult(result);
    }
    return match;
  }
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
