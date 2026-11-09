import { Inject, Injectable } from '@nestjs/common';
import type { MatchSnapshot } from '../domain/match';
import { MATCH_REPOSITORY, type MatchRepository } from './match.repository';

export interface RecordMatchResultInput {
  readonly matchId: string;
  readonly operationId: string;
  readonly winnerId: string;
  /** Must come from a trusted, authorized caller, never an unchecked HTTP body. */
  readonly actorId: string;
}

export class MatchNotFoundError extends Error {
  constructor(readonly matchId: string) {
    super('The match was not found.');
    this.name = 'MatchNotFoundError';
  }
}

/** Internal use case; its caller must establish result-recording authorization. */
@Injectable()
export class RecordMatchResultService {
  constructor(
    @Inject(MATCH_REPOSITORY)
    private readonly repository: MatchRepository,
  ) {}

  async execute(input: RecordMatchResultInput): Promise<MatchSnapshot> {
    const match = await this.repository.findById(input.matchId);
    if (!match) {
      throw new MatchNotFoundError(input.matchId);
    }

    const expectedVersion = match.version;
    const changed = match.recordResult({
      operationId: input.operationId,
      winnerId: input.winnerId,
      recordedBy: input.actorId,
      recordedAt: new Date().toISOString(),
    });

    if (changed) {
      await this.repository.save(match, expectedVersion);
    }
    return match.toSnapshot();
  }
}
