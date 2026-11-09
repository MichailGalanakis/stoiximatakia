import {
  MatchConcurrencyError,
  type MatchRepository,
} from '../../src/matches/application/match.repository';
import { Match, type MatchSnapshot } from '../../src/matches/domain/match';

/** Test fixture only: process-local memory is not durable business persistence. */
export class InMemoryMatchRepository implements MatchRepository {
  private readonly snapshots = new Map<string, MatchSnapshot>();

  constructor(matches: readonly Match[] = []) {
    for (const match of matches) {
      this.snapshots.set(match.id, match.toSnapshot());
    }
  }

  findById(id: string): Promise<Match | null> {
    const snapshot = this.snapshots.get(id);
    return Promise.resolve(snapshot ? Match.fromSnapshot(snapshot) : null);
  }

  save(match: Match, expectedVersion: number): Promise<void> {
    const stored = this.snapshots.get(match.id);
    if (
      !stored ||
      stored.version !== expectedVersion ||
      match.version !== expectedVersion + 1
    ) {
      return Promise.reject(new MatchConcurrencyError(match.id));
    }
    this.snapshots.set(match.id, match.toSnapshot());
    return Promise.resolve();
  }
}
