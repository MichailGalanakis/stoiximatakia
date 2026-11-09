export const REGISTRATION_SETTINGS = Symbol('REGISTRATION_SETTINGS');
export const TERMS_VERSION = '2026-10-20-a4';
export const SESSION_SECONDS = 86_400;

export interface RegistrationSettings {
  databaseUrl: string | undefined;
  appOrigin: string;
  secureCookie: boolean;
}

function configUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error('Invalid registration URL configuration');
  }
}

export function registrationSettings(
  env: NodeJS.ProcessEnv = process.env,
): RegistrationSettings {
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL)
    throw new Error('DATABASE_URL is required in production');
  const origin = configUrl(env.APP_ORIGIN ?? 'http://127.0.0.1:3100');
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (env.NODE_ENV === 'production' && origin.protocol !== 'https:')
  )
    throw new Error('APP_ORIGIN must be an origin; production requires HTTPS');
  if (env.DATABASE_URL) {
    const database = configUrl(env.DATABASE_URL);
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.pathname.length < 2
    )
      throw new Error('DATABASE_URL must use PostgreSQL');
  }
  return {
    databaseUrl: env.DATABASE_URL,
    appOrigin: origin.origin,
    secureCookie: origin.protocol === 'https:',
  };
}
