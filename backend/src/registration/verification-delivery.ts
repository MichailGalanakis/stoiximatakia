import { Inject, Injectable } from '@nestjs/common';

export type Channel = 'email' | 'phone';
export const VERIFICATION_CONFIG = Symbol('VERIFICATION_CONFIG');
export const VERIFICATION_DELIVERY = Symbol('VERIFICATION_DELIVERY');
export interface VerificationConfig {
  secret: string | undefined;
  resendKey: string | undefined;
  resendFrom: string;
  sevenKey: string | undefined;
  sevenSender: string;
}
export interface VerificationDelivery {
  available(channel: Channel): boolean;
  send(input: {
    channel: Channel;
    destination: string;
    code: string;
    requestId: string;
  }): Promise<void>;
}
export function verificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): VerificationConfig {
  const secret = env.OTP_SECRET;
  if (
    (env.RESEND_API_KEY || env.SEVEN_API_KEY) &&
    (!secret || secret.length < 64)
  )
    throw new Error(
      'OTP_SECRET must contain at least 64 characters when delivery is configured',
    );
  const resendFrom = env.RESEND_FROM || 'SkillBetting <onboarding@resend.dev>';
  const sevenSender = env.SEVEN_SENDER || 'SkillBet';
  if (/[\r\n]/.test(resendFrom))
    throw new Error('RESEND_FROM must not contain line breaks');
  if (!/^(?:[A-Za-z0-9]{1,11}|[0-9]{1,16})$/.test(sevenSender))
    throw new Error(
      'SEVEN_SENDER must be 1–11 alphanumeric characters or 1–16 digits',
    );
  return {
    secret,
    resendKey: env.RESEND_API_KEY || undefined,
    resendFrom,
    sevenKey: env.SEVEN_API_KEY || undefined,
    sevenSender,
  };
}

@Injectable()
export class HttpVerificationDelivery implements VerificationDelivery {
  constructor(
    @Inject(VERIFICATION_CONFIG) private readonly config: VerificationConfig,
  ) {}
  available(channel: Channel): boolean {
    return (
      !!this.config.secret &&
      !!(channel === 'email' ? this.config.resendKey : this.config.sevenKey)
    );
  }
  async send(input: {
    channel: Channel;
    destination: string;
    code: string;
    requestId: string;
  }): Promise<void> {
    // Never return provider bodies/errors: seven's JSON may echo the full SMS code.
    const email = input.channel === 'email';
    const response = await fetch(
      email
        ? 'https://api.resend.com/emails'
        : 'https://gateway.seven.io/api/sms',
      {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: email
          ? {
              Authorization: `Bearer ${this.config.resendKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': `registration/${input.requestId}`,
            }
          : {
              'X-Api-Key': this.config.sevenKey!,
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
        body: email
          ? JSON.stringify({
              from: this.config.resendFrom,
              to: [input.destination],
              subject: 'Κωδικός επιβεβαίωσης SkillBetting',
              text: `Ο κωδικός επιβεβαίωσής σου είναι ${input.code}. Ισχύει για 10 λεπτά. Αν δεν ζήτησες εγγραφή, αγνόησε αυτό το μήνυμα.`,
            })
          : new URLSearchParams({
              to: input.destination,
              from: this.config.sevenSender,
              text: `SkillBetting code: ${input.code}. Expires in 10 minutes.`,
              foreign_id: input.requestId,
              ttl: '10',
            }).toString(),
      },
    );
    const body: unknown = await response.json();
    if (!response.ok || !body || typeof body !== 'object')
      throw new Error('delivery_failed');
    if (email) {
      if (!('id' in body) || typeof body.id !== 'string' || !body.id)
        throw new Error('delivery_failed');
    } else {
      if (
        !('success' in body) ||
        String(body.success) !== '100' ||
        !('messages' in body) ||
        !Array.isArray(body.messages) ||
        body.messages.length !== 1 ||
        !('debug' in body) ||
        (body.debug !== false && body.debug !== 'false')
      )
        throw new Error('delivery_failed');
      const message: unknown = body.messages[0];
      if (
        !message ||
        typeof message !== 'object' ||
        !('success' in message) ||
        message.success !== true
      )
        throw new Error('delivery_failed');
    }
  }
}
