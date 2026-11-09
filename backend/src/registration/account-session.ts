import type { FastifyRequest } from 'fastify';

export const ACCOUNT_SESSION_SECONDS = 60 * 60 * 24 * 30;

export interface AccountRow {
  id: string;
  username: string;
  account_kind: 'registered' | 'demo';
  email: string;
  phone: string;
  email_verified: boolean;
  phone_verified: boolean;
  demo_credits_minor: number;
}

export function accountView(user: AccountRow) {
  return {
    id: user.id,
    username: user.username,
    kind: user.account_kind,
    email: user.email,
    phone: user.phone,
    emailVerified: user.email_verified,
    phoneVerified: user.phone_verified,
    // Compatibility field: authoritative available credits from the single ledger.
    demoCreditsMinor: user.demo_credits_minor,
  };
}

export function readCookie(request: FastifyRequest, name: string) {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function sessionCookie(
  name: string,
  token: string,
  secure: boolean,
  seconds: number,
) {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
