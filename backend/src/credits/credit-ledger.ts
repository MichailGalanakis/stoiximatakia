import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export const MAX_CREDITS_MINOR = Number.MAX_SAFE_INTEGER;
// Retain the existing response name while removing legacy-counter authority.
export const ACCOUNT_CREDIT_COLUMNS = `u.*, (SELECT c.balance_minor::float8 FROM credit_accounts c WHERE c.user_id=u.id AND c.kind='available') AS demo_credits_minor`;

export interface Posting {
  account: string;
  amount: number;
}

export async function postCredits(
  client: PoolClient,
  input: {
    operationKey: string;
    kind: 'reserve' | 'release' | 'start' | 'settle';
    referenceId: string;
    actorId?: string;
    postings: readonly Posting[];
  },
): Promise<string> {
  const postings = [...input.postings].sort((a, b) =>
    a.account.localeCompare(b.account),
  );
  if (
    postings.length < 2 ||
    new Set(postings.map((p) => p.account)).size !== postings.length ||
    postings.some((p) => !Number.isSafeInteger(p.amount) || p.amount === 0) ||
    postings.reduce((sum, p) => sum + BigInt(p.amount), 0n) !== 0n
  )
    throw new Error('Invalid balanced credit transaction');
  // Stable lock order protects transfers across accounts/processes.
  const accounts = await client.query<{ key: string; balance_minor: string }>(
    'SELECT key,balance_minor FROM credit_accounts WHERE key=ANY($1::text[]) ORDER BY key FOR UPDATE',
    [postings.map((p) => p.account)],
  );
  if (accounts.rowCount !== postings.length)
    throw new Error('Missing credit account');
  const id = randomUUID();
  await client.query(
    'INSERT INTO credit_journals(id,operation_key,kind,reference_id,actor_user_id) VALUES($1,$2,$3,$4,$5)',
    [
      id,
      input.operationKey,
      input.kind,
      input.referenceId,
      input.actorId ?? null,
    ],
  );
  for (const posting of postings)
    await client.query(
      'INSERT INTO credit_postings(journal_id,account_key,amount_minor) VALUES($1,$2,$3)',
      [id, posting.account, posting.amount],
    );
  return id;
}
