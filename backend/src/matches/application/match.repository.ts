import type { Match } from '../domain/match';

export const MATCH_REPOSITORY = Symbol('MATCH_REPOSITORY');

/**
 * Implementations must return independent aggregates. Saving must atomically
 * compare the stored version, require one version advance, and persist
 * state/history in one transaction. An unchanged or older aggregate cannot save.
 */
export interface MatchRepository {
  findById(id: string): Promise<Match | null>;
  save(match: Match, expectedVersion: number): Promise<void>;
}

export class MatchConcurrencyError extends Error {
  constructor(readonly matchId: string) {
    super(
      'The match changed before this operation could be saved. Reload and retry.',
    );
    this.name = 'MatchConcurrencyError';
  }
}
