import type { PoolClient } from 'pg';
import { postCredits, type Posting } from '../credits/credit-ledger';
import { postWallet } from '../wallet/wallet-ledger';

export type TableCurrency = 'credits' | 'EUR';
export const TABLE_CURRENCIES: readonly TableCurrency[] = ['credits', 'EUR'];

const WALLET_KIND = {
  reserve: 'stake_reserve',
  release: 'stake_release',
  start: 'stake_commit',
  settle: 'settle',
} as const;

// Player account keys are identical in both ledgers; only shared accounts differ.
export const poolAccount = (currency: TableCurrency, tableId: string) =>
  (currency === 'EUR' ? 'prize_pool:' : 'pool:') + tableId;
export const feeAccount = (currency: TableCurrency) =>
  currency === 'EUR' ? 'house_revenue' : 'fees';

/** Posts table money to the ledger of the table's currency, never across them. */
export function postTableMoney(
  c: PoolClient,
  currency: TableCurrency,
  input: {
    operationKey: string;
    kind: keyof typeof WALLET_KIND;
    referenceId: string;
    actorId?: string | undefined;
    postings: readonly Posting[];
  },
): Promise<string> {
  const actor = input.actorId ? { actorId: input.actorId } : {};
  return currency === 'EUR'
    ? postWallet(c, {
        operationKey: input.operationKey,
        kind: WALLET_KIND[input.kind],
        referenceId: input.referenceId,
        ...actor,
        entries: input.postings,
      })
    : postCredits(c, {
        operationKey: input.operationKey,
        kind: input.kind,
        referenceId: input.referenceId,
        ...actor,
        postings: input.postings,
      });
}

export async function openPool(
  c: PoolClient,
  currency: TableCurrency,
  tableId: string,
): Promise<void> {
  await c.query(
    currency === 'EUR'
      ? "INSERT INTO wallet_accounts(key,kind) VALUES($1,'prize_pool')"
      : "INSERT INTO credit_accounts(key,kind) VALUES($1,'pool')",
    [poolAccount(currency, tableId)],
  );
}

export async function poolBalance(
  c: PoolClient,
  currency: TableCurrency,
  tableId: string,
): Promise<number | undefined> {
  const { rows } = await c.query<{ amount: number }>(
    `SELECT balance_minor::float8 AS amount FROM ${currency === 'EUR' ? 'wallet_accounts' : 'credit_accounts'} WHERE key=$1`,
    [poolAccount(currency, tableId)],
  );
  return rows[0]?.amount;
}

export async function playerBalance(
  c: PoolClient,
  currency: TableCurrency,
  userId: string,
): Promise<{ availableMinor: number; reservedMinor: number } | undefined> {
  const { rows } = await c.query<{ kind: string; amount: number }>(
    `SELECT kind,balance_minor::float8 AS amount FROM ${currency === 'EUR' ? 'wallet_accounts' : 'credit_accounts'}
     WHERE user_id=$1 AND kind IN ('available','reserved')`,
    [userId],
  );
  const availableMinor = rows.find((r) => r.kind === 'available')?.amount;
  const reservedMinor = rows.find((r) => r.kind === 'reserved')?.amount;
  if (availableMinor === undefined || reservedMinor === undefined)
    return undefined;
  return { availableMinor, reservedMinor };
}
