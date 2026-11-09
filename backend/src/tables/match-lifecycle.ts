import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { postCredits } from '../credits/credit-ledger';
import type { TableRow } from './platform.store';
import { PlatformError } from './platform-error';

export interface GameRow {
  table_id: string;
  rules_version: string;
  engine_version: string;
  state: unknown;
  revision: number;
  accepted_gameplay_count: number;
}
export interface RosterMember {
  user_id: string;
  seat_index: number;
  ticket_id: string;
}
export interface MatchSummary {
  revision: number;
  hasGameplay: boolean;
  outcome: {
    id: string;
    kind: 'win' | 'draw' | 'cancel' | 'void';
    reason: string;
    winnerUserIds: string[];
    createdAt: string;
    ownReturnMinor: number;
  } | null;
}
export async function loadGame(c: PoolClient, id: string): Promise<GameRow> {
  const game = (
    await c.query<GameRow>('SELECT * FROM table_games WHERE table_id=$1', [id])
  ).rows[0];
  if (!game) throw new PlatformError('game_not_started', 409);
  return game;
}
export async function roster(
  c: PoolClient,
  id: string,
): Promise<RosterMember[]> {
  return (
    await c.query<RosterMember>(
      'SELECT * FROM match_roster WHERE table_id=$1 ORDER BY seat_index',
      [id],
    )
  ).rows;
}
export async function participant(
  c: PoolClient,
  id: string,
  userId: string,
): Promise<RosterMember[]> {
  const members = await roster(c, id);
  if (!members.some((m) => m.user_id === userId))
    throw new PlatformError('not_participating', 403);
  return members;
}
export async function summary(
  c: PoolClient,
  id: string,
  viewer: string,
): Promise<MatchSummary> {
  await participant(c, id, viewer);
  const game = await loadGame(c, id);
  const result = (
    await c.query<{
      id: string;
      kind: 'win' | 'draw' | 'cancel' | 'void';
      reason: string;
      winner_ids: string[];
      created_at: Date;
      amount_minor: number;
    }>(
      `SELECT r.*,a.amount_minor FROM match_results r JOIN match_allocations a ON a.result_id=r.id AND a.user_id=$2 WHERE r.table_id=$1`,
      [id, viewer],
    )
  ).rows[0];
  return {
    revision: game.revision,
    hasGameplay: game.accepted_gameplay_count > 0,
    outcome: result
      ? {
          id: result.id,
          kind: result.kind,
          reason: result.reason,
          winnerUserIds: result.winner_ids,
          createdAt: result.created_at.toISOString(),
          ownReturnMinor: result.amount_minor,
        }
      : null,
  };
}
export function checkRevision(game: GameRow, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected !== game.revision)
    throw new PlatformError('stale_game_revision', 409);
}
export function requirePlaying(table: TableRow): void {
  if (table.status === 'waiting')
    throw new PlatformError('game_not_started', 409);
  if (table.status !== 'playing') throw new PlatformError('match_ended', 409);
}
export function validWinners(
  table: TableRow,
  members: readonly RosterMember[],
  winners: readonly string[],
): string[] {
  const ids = [...winners].sort();
  const expected = table.capacity === 4 ? 2 : 1;
  if (
    ids.length !== expected ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !members.some((m) => m.user_id === id))
  )
    throw new Error('Invalid authoritative winning side');
  if (
    table.capacity === 4 &&
    new Set(
      members
        .filter((m) => ids.includes(m.user_id))
        .map((m) => m.seat_index % 2),
    ).size !== 1
  )
    throw new Error('A complete opposing partnership must win');
  return ids;
}
export async function startHistory(
  c: PoolClient,
  id: string,
  actor: string,
): Promise<void> {
  const game = await loadGame(c, id);
  await c.query(
    'INSERT INTO match_roster(table_id,user_id,seat_index,ticket_id) SELECT table_id,user_id,seat_index,ticket_id FROM table_participations WHERE table_id=$1',
    [id],
  );
  await c.query(
    "INSERT INTO match_events(table_id,revision,kind,actor_user_id,payload) VALUES($1,1,'start',$2,$3)",
    [
      id,
      actor,
      JSON.stringify({
        engineVersion: game.engine_version,
        rulesVersion: game.rules_version,
        initialState: game.state,
      }),
    ],
  );
}
export async function advanceGame(
  c: PoolClient,
  game: GameRow,
  input: {
    kind: 'action' | 'forfeit' | 'cancel' | 'void';
    actor?: string;
    gameplay?: boolean;
    payload: unknown;
    state?: unknown;
  },
): Promise<number> {
  const next = game.revision + 1;
  await c.query(
    'UPDATE table_games SET revision=$2,accepted_gameplay_count=accepted_gameplay_count+$3,state=$4 WHERE table_id=$1',
    [
      game.table_id,
      next,
      input.gameplay ? 1 : 0,
      JSON.stringify('state' in input ? input.state : game.state),
    ],
  );
  await c.query(
    'INSERT INTO match_events(table_id,revision,kind,gameplay,actor_user_id,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [
      game.table_id,
      next,
      input.kind,
      input.gameplay ?? false,
      input.actor ?? null,
      JSON.stringify(input.payload),
    ],
  );
  return next;
}

/** Initial result and its separate, append-only settlement commit atomically. */
export async function concludeMatch(
  c: PoolClient,
  table: TableRow,
  gameRevision: number,
  input: {
    kind: 'win' | 'draw' | 'cancel' | 'void';
    reason: string;
    winners?: readonly string[];
    source: 'engine' | 'participant' | 'backend';
    actor?: string;
    evidence: unknown;
  },
): Promise<string> {
  const members = await roster(c, table.id);
  if (members.length !== table.capacity)
    throw new Error('Incomplete funded roster');
  const winners =
    input.kind === 'win'
      ? validWinners(table, members, input.winners ?? [])
      : [];
  if (!input.reason || input.reason.length > 128)
    throw new Error('Invalid outcome reason');
  const refundFee = input.kind === 'cancel' || input.kind === 'void';
  const pool = table.capacity * table.contribution_minor,
    fees = table.capacity * table.entry_fee_minor;
  const balance = (
    await c.query<{ amount: string }>(
      'SELECT balance_minor AS amount FROM credit_accounts WHERE key=$1',
      ['pool:' + table.id],
    )
  ).rows[0];
  if (Number(balance?.amount) !== pool)
    throw new Error('Match pool does not reconcile');
  const allocations = members.map((m) => ({
    userId: m.user_id,
    amount:
      input.kind === 'win'
        ? winners.includes(m.user_id)
          ? pool / winners.length
          : 0
        : table.contribution_minor + (refundFee ? table.entry_fee_minor : 0),
  }));
  const id = randomUUID();
  await c.query(
    'INSERT INTO match_results(id,table_id,game_revision,kind,reason,winner_ids,source,actor_user_id,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      table.id,
      gameRevision,
      input.kind,
      input.reason,
      winners,
      input.source,
      input.actor ?? null,
      JSON.stringify(input.evidence),
    ],
  );
  const journal = await postCredits(c, {
    operationKey: 'settle:' + id,
    kind: 'settle',
    referenceId: id,
    ...(input.actor ? { actorId: input.actor } : {}),
    postings: [
      { account: 'pool:' + table.id, amount: -pool },
      ...(refundFee ? [{ account: 'fees', amount: -fees }] : []),
      ...allocations
        .filter((a) => a.amount > 0)
        .map((a) => ({ account: 'available:' + a.userId, amount: a.amount })),
    ],
  });
  await c.query(
    'INSERT INTO match_settlements(result_id,table_id,journal_id,total_paid_minor,fee_returned_minor) VALUES($1,$2,$3,$4,$5)',
    [
      id,
      table.id,
      journal,
      pool + (refundFee ? fees : 0),
      refundFee ? fees : 0,
    ],
  );
  for (const a of allocations)
    await c.query(
      'INSERT INTO match_allocations(result_id,table_id,user_id,amount_minor) VALUES($1,$2,$3,$4)',
      [id, table.id, a.userId, a.amount],
    );
  await c.query('UPDATE table_tickets SET state=$2 WHERE id=ANY($1::uuid[])', [
    members.map((m) => m.ticket_id),
    refundFee ? 'refunded' : 'settled',
  ]);
  await c.query('DELETE FROM table_participations WHERE table_id=$1', [
    table.id,
  ]);
  await c.query('UPDATE game_tables SET status=$2 WHERE id=$1', [
    table.id,
    refundFee ? 'cancelled' : 'completed',
  ]);
  return id;
}
