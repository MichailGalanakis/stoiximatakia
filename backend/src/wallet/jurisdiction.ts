import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { PoolClient } from 'pg';
import { WalletError } from './wallet-error';

/**
 * A KYC or finance-set country wins; until KYC exists, the registered phone
 * number's country is used. The free-text profile country is never trusted.
 */
export async function playerCountry(
  c: PoolClient,
  userId: string,
): Promise<string | null> {
  const { rows } = await c.query<{ override: string | null; phone: string }>(
    `SELECT j.country AS override,u.phone FROM users u
     LEFT JOIN player_jurisdictions j ON j.user_id=u.id WHERE u.id=$1`,
    [userId],
  );
  if (!rows[0]) return null;
  return (
    rows[0].override ??
    parsePhoneNumberFromString(rows[0].phone)?.country ??
    null
  );
}

/** Real-money activity only for players in an approved jurisdiction. */
export async function requireJurisdiction(
  c: PoolClient,
  userId: string,
): Promise<string> {
  const country = await playerCountry(c, userId);
  const approved = country
    ? await c.query<{ approved: boolean }>(
        'SELECT approved FROM jurisdictions WHERE country=$1',
        [country],
      )
    : undefined;
  if (!country || !approved?.rows[0]?.approved)
    throw new WalletError('jurisdiction_unavailable', 403);
  return country;
}

export async function activeMethod(
  c: PoolClient,
  input: {
    country: string;
    direction: 'deposit' | 'withdrawal';
    method?: string;
    provider?: string;
  },
): Promise<{ method: string; provider: string } | undefined> {
  const { rows } = await c.query<{ method: string; provider: string }>(
    `SELECT method,provider FROM payment_methods
     WHERE country=$1 AND direction=$2 AND active AND currency='EUR'
       AND ($3::text IS NULL OR method=$3) AND ($4::text IS NULL OR provider=$4)
     ORDER BY method,provider LIMIT 1`,
    [
      input.country,
      input.direction,
      input.method ?? null,
      input.provider ?? null,
    ],
  );
  return rows[0];
}
