import type { PoolClient } from 'pg';
import { requireJurisdiction } from './jurisdiction';
import { WalletError } from './wallet-error';
import { postWallet, userAccount } from './wallet-ledger';

export type HouseOutcome = 'won' | 'lost' | 'void';

export interface HouseMatch {
  id: string;
  userId: string;
  offerId: string;
  gameId: string;
  stakeMinor: number;
  prizeMinor: number;
  status: 'active' | HouseOutcome;
  createdAt: string;
  settledAt: string | null;
}

interface HouseMatchRow {
  id: string;
  user_id: string;
  offer_id: string;
  game_id: string;
  stake_minor: number;
  prize_minor: number;
  status: HouseMatch['status'];
  created_at: Date;
  settled_at: Date | null;
}
export const HOUSE_MATCH_COLUMNS =
  'id,user_id,offer_id,game_id,stake_minor::float8 AS stake_minor,prize_minor::float8 AS prize_minor,status,created_at,settled_at';
export const houseMatchView = (m: HouseMatchRow): HouseMatch => ({
  id: m.id,
  userId: m.user_id,
  offerId: m.offer_id,
  gameId: m.game_id,
  stakeMinor: m.stake_minor,
  prizeMinor: m.prize_minor,
  status: m.status,
  createdAt: m.created_at.toISOString(),
  settledAt: m.settled_at?.toISOString() ?? null,
});

const matchAccount = (id: string) => `house_match:${id}`;

/**
 * Takes the player's stake and locks the rest of the prize from the reserve, so
 * every accepted match can be paid even if all active players win at once.
 */
export async function startHouseMatch(
  c: PoolClient,
  input: { matchId: string; userId: string; offerId: string; gameId: string },
): Promise<HouseMatch> {
  await requireJurisdiction(c, input.userId);
  const offer = await c.query<{ stake: number; prize: number }>(
    'SELECT stake_minor::float8 AS stake,prize_minor::float8 AS prize FROM house_offers WHERE id=$1 AND active FOR SHARE',
    [input.offerId],
  );
  if (!offer.rows[0]) throw new WalletError('house_offer_unavailable', 409);
  const { stake, prize } = offer.rows[0];
  const exposure = prize - stake;
  const active = await c.query(
    "SELECT 1 FROM house_matches WHERE user_id=$1 AND status='active'",
    [input.userId],
  );
  if (active.rowCount) throw new WalletError('house_match_active', 409);
  const balances = await c.query<{ key: string; amount: number }>(
    'SELECT key,balance_minor::float8 AS amount FROM wallet_accounts WHERE key=ANY($1::text[]) ORDER BY key FOR UPDATE',
    [[userAccount('available', input.userId), 'house_reserve']],
  );
  const of = (key: string) =>
    balances.rows.find((r) => r.key === key)?.amount ?? 0;
  if (of(userAccount('available', input.userId)) < stake)
    throw new WalletError('insufficient_funds', 409);
  if (of('house_reserve') < exposure)
    throw new WalletError('house_reserve_insufficient', 503);
  await c.query(
    "INSERT INTO wallet_accounts(key,kind) VALUES($1,'house_match')",
    [matchAccount(input.matchId)],
  );
  const tx = await postWallet(c, {
    operationKey: `house_stake:${input.matchId}`,
    kind: 'house_stake',
    referenceId: input.matchId,
    actorId: input.userId,
    entries: [
      { account: userAccount('available', input.userId), amount: -stake },
      { account: 'house_reserve', amount: -exposure },
      { account: matchAccount(input.matchId), amount: prize },
    ],
  });
  const { rows } = await c.query<HouseMatchRow>(
    `INSERT INTO house_matches(id,user_id,offer_id,game_id,stake_minor,prize_minor,stake_transaction_id)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${HOUSE_MATCH_COLUMNS}`,
    [
      input.matchId,
      input.userId,
      input.offerId,
      input.gameId,
      stake,
      prize,
      tx,
    ],
  );
  return houseMatchView(rows[0]!);
}

/**
 * Releases the locked prize exactly once. Only the server's game result may call
 * this; a repeated identical outcome returns the settled match unchanged.
 */
export async function settleHouseMatch(
  c: PoolClient,
  matchId: string,
  outcome: HouseOutcome,
): Promise<HouseMatch> {
  const { rows } = await c.query<HouseMatchRow>(
    `SELECT ${HOUSE_MATCH_COLUMNS} FROM house_matches WHERE id=$1 FOR UPDATE`,
    [matchId],
  );
  const m = rows[0];
  if (!m) throw new WalletError('house_match_not_found', 404);
  if (m.status !== 'active') {
    if (m.status === outcome) return houseMatchView(m);
    throw new WalletError('house_match_settled', 409);
  }
  const exposure = m.prize_minor - m.stake_minor;
  const available = userAccount('available', m.user_id);
  const entries =
    outcome === 'won'
      ? [{ account: available, amount: m.prize_minor }]
      : outcome === 'lost'
        ? [
            { account: 'house_revenue', amount: m.stake_minor },
            { account: 'house_reserve', amount: exposure },
          ]
        : [
            { account: available, amount: m.stake_minor },
            { account: 'house_reserve', amount: exposure },
          ];
  const tx = await postWallet(c, {
    operationKey: `house_settle:${m.id}`,
    kind: 'house_settle',
    referenceId: m.id,
    entries: [
      { account: matchAccount(m.id), amount: -m.prize_minor },
      ...entries,
    ],
  });
  const updated = await c.query<HouseMatchRow>(
    `UPDATE house_matches SET status=$2,settle_transaction_id=$3,settled_at=now()
     WHERE id=$1 RETURNING ${HOUSE_MATCH_COLUMNS}`,
    [m.id, outcome, tx],
  );
  return houseMatchView(updated.rows[0]!);
}
