export const PLATFORM_SETTINGS = Symbol('PLATFORM_SETTINGS');
export interface PlatformSettings {
  codeSecret: string | undefined;
  /** Production cannot reserve funds for an unfinished/unregistered game. */
  requireGameRuntime?: boolean;
}
export function platformSettings(
  env: NodeJS.ProcessEnv = process.env,
): PlatformSettings {
  const codeSecret = env.TABLE_CODE_SECRET || undefined;
  if (env.NODE_ENV === 'production' && !codeSecret)
    throw new Error('TABLE_CODE_SECRET is required in production');
  if (codeSecret !== undefined && Buffer.byteLength(codeSecret) < 32)
    throw new Error('TABLE_CODE_SECRET must contain at least 32 bytes');
  return { codeSecret, requireGameRuntime: env.NODE_ENV === 'production' };
}
