export const WALLET_SETTINGS = Symbol('WALLET_SETTINGS');

export interface WalletSettings {
  /** Enables the sandbox provider. No real-money provider exists yet. */
  sandboxSecret: string | undefined;
  /** Enables the admin finance endpoints (Bearer token). */
  adminToken: string | undefined;
  minDepositMinor: number;
  maxDepositMinor: number;
  minWithdrawalMinor: number;
  withdrawalsPerDay: number;
  /** A request may always take up to this amount (capped by the balance). */
  withdrawalFloorMinor: number;
  /** Above the floor, a request may take this share of the available balance. */
  withdrawalShareBps: number;
}

/** Owner rule: up to €100 in full, otherwise 80% of the available balance. */
export function maxWithdrawableMinor(
  availableMinor: number,
  settings: Pick<WalletSettings, 'withdrawalFloorMinor' | 'withdrawalShareBps'>,
): number {
  const share = Math.floor(
    (availableMinor * settings.withdrawalShareBps) / 10_000,
  );
  return Math.min(
    availableMinor,
    Math.max(settings.withdrawalFloorMinor, share),
  );
}

function amount(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = 100_000_000,
): number {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > max)
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  return Number(text);
}

function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name] || undefined;
  if (value !== undefined && Buffer.byteLength(value) < 32)
    throw new Error(`${name} must contain at least 32 bytes`);
  return value;
}

export function walletSettings(
  env: NodeJS.ProcessEnv = process.env,
): WalletSettings {
  const settings: WalletSettings = {
    sandboxSecret: secret(env, 'WALLET_SANDBOX_SECRET'),
    adminToken: secret(env, 'WALLET_ADMIN_TOKEN'),
    minDepositMinor: amount(env, 'WALLET_MIN_DEPOSIT_MINOR', 500),
    maxDepositMinor: amount(env, 'WALLET_MAX_DEPOSIT_MINOR', 100_000),
    minWithdrawalMinor: amount(env, 'WALLET_MIN_WITHDRAWAL_MINOR', 1000),
    withdrawalsPerDay: amount(env, 'WALLET_WITHDRAWALS_PER_DAY', 3, 100),
    withdrawalFloorMinor: amount(env, 'WALLET_WITHDRAWAL_FLOOR_MINOR', 10_000),
    withdrawalShareBps: amount(
      env,
      'WALLET_WITHDRAWAL_SHARE_BPS',
      8000,
      10_000,
    ),
  };
  if (settings.minDepositMinor > settings.maxDepositMinor)
    throw new Error(
      'WALLET_MIN_DEPOSIT_MINOR exceeds WALLET_MAX_DEPOSIT_MINOR',
    );
  return settings;
}
