import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export type LedgerKind =
  | 'deposit'
  | 'withdrawal_hold'
  | 'withdrawal_release'
  | 'withdrawal_paid'
  | 'stake_reserve'
  | 'stake_release'
  | 'stake_commit'
  | 'settle'
  | 'capital_in'
  | 'capital_out'
  | 'house_stake'
  | 'house_settle';

export interface Entry {
  account: string;
  amount: number;
}

export const userAccount = (
  kind: 'available' | 'reserved' | 'withdrawal_pending',
  userId: string,
) => `${kind}:${userId}`;
export const externalAccount = (provider: string) => `external:${provider}`;

/** Posts one balanced euro transaction; the database rejects overdrafts and imbalance. */
export async function postWallet(
  client: PoolClient,
  input: {
    operationKey: string;
    kind: LedgerKind;
    referenceId: string;
    actorId?: string | undefined;
    entries: readonly Entry[];
  },
): Promise<string> {
  const entries = [...input.entries].sort((a, b) =>
    a.account.localeCompare(b.account),
  );
  if (
    entries.length < 2 ||
    new Set(entries.map((e) => e.account)).size !== entries.length ||
    entries.some((e) => !Number.isSafeInteger(e.amount) || e.amount === 0) ||
    entries.reduce((sum, e) => sum + BigInt(e.amount), 0n) !== 0n
  )
    throw new Error('Invalid balanced wallet transaction');
  // Stable lock order protects concurrent transfers across processes.
  const accounts = await client.query(
    'SELECT key FROM wallet_accounts WHERE key=ANY($1::text[]) ORDER BY key FOR UPDATE',
    [entries.map((e) => e.account)],
  );
  if (accounts.rowCount !== entries.length)
    throw new Error('Missing wallet account');
  const id = randomUUID();
  await client.query(
    'INSERT INTO ledger_transactions(id,operation_key,kind,reference_id,actor_user_id) VALUES($1,$2,$3,$4,$5)',
    [
      id,
      input.operationKey,
      input.kind,
      input.referenceId,
      input.actorId ?? null,
    ],
  );
  for (const entry of entries)
    await client.query(
      'INSERT INTO ledger_entries(transaction_id,account_key,amount_minor) VALUES($1,$2,$3)',
      [id, entry.account, entry.amount],
    );
  return id;
}
