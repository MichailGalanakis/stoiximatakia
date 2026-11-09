import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type ProviderEventType =
  'deposit.succeeded' | 'deposit.failed' | 'payout.succeeded' | 'payout.failed';

/** A verified provider notification, keyed by our own deposit/withdrawal ID. */
export interface ProviderEvent {
  id: string;
  type: ProviderEventType;
  paymentId: string;
  providerReference: string;
  amountMinor: number;
  currency: string;
}

export class InvalidProviderEvent extends Error {}

/**
 * Each PSP adapter implements this; the wallet engine never sees provider APIs.
 * Real adapters must treat our payment ID as their idempotency key.
 */
export interface PaymentProvider {
  readonly id: string;
  createDeposit(input: {
    depositId: string;
    amountMinor: number;
    currency: 'EUR';
  }): Promise<{ providerReference: string; redirectUrl: string }>;
  createPayout(input: {
    withdrawalId: string;
    amountMinor: number;
    currency: 'EUR';
  }): Promise<{ providerReference: string }>;
  /** Throws InvalidProviderEvent unless the signature and payload are valid. */
  parseWebhook(raw: Buffer, headers: IncomingHttpHeaders): ProviderEvent;
}

const TOLERANCE_SECONDS = 300;
const EVENT_TYPES = new Set<string>([
  'deposit.succeeded',
  'deposit.failed',
  'payout.succeeded',
  'payout.failed',
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function signSandboxEvent(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Moves no real money. Its "hosted page" is simulated by signed test events. */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly id = 'sandbox';
  constructor(
    private readonly secret: string,
    private readonly appOrigin: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  createDeposit(input: { depositId: string }) {
    const providerReference = `sbx_dep_${input.depositId}`;
    const url = new URL('/wallet/sandbox-checkout', this.appOrigin);
    url.searchParams.set('reference', providerReference);
    return Promise.resolve({ providerReference, redirectUrl: url.href });
  }

  createPayout(input: { withdrawalId: string }) {
    return Promise.resolve({
      providerReference: `sbx_pay_${input.withdrawalId}`,
    });
  }

  parseWebhook(raw: Buffer, headers: IncomingHttpHeaders): ProviderEvent {
    const header = headers['x-sandbox-signature'];
    const match =
      typeof header === 'string'
        ? /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header)
        : null;
    if (!match) throw new InvalidProviderEvent('signature');
    const timestamp = Number(match[1]);
    if (Math.abs(this.now() / 1000 - timestamp) > TOLERANCE_SECONDS)
      throw new InvalidProviderEvent('timestamp');
    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(raw)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2]!, 'hex')))
      throw new InvalidProviderEvent('signature');
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new InvalidProviderEvent('payload');
    }
    const e = body as Partial<ProviderEvent>;
    if (
      typeof e.id !== 'string' ||
      e.id.length < 1 ||
      e.id.length > 200 ||
      typeof e.type !== 'string' ||
      !EVENT_TYPES.has(e.type) ||
      typeof e.paymentId !== 'string' ||
      !UUID.test(e.paymentId) ||
      typeof e.providerReference !== 'string' ||
      e.providerReference.length > 200 ||
      !Number.isSafeInteger(e.amountMinor) ||
      typeof e.currency !== 'string'
    )
      throw new InvalidProviderEvent('payload');
    return e as ProviderEvent;
  }
}
