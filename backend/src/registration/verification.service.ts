import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RegistrationStore, type registrationView } from './registration.store';
import { RegistrationError } from './registration-error';
import {
  VERIFICATION_CONFIG,
  VERIFICATION_DELIVERY,
  type VerificationConfig,
  type VerificationDelivery,
  type Channel,
} from './verification-delivery';

type User = ReturnType<typeof registrationView>;
@Injectable()
export class VerificationService {
  constructor(
    @Inject(RegistrationStore) private readonly store: RegistrationStore,
    @Inject(VERIFICATION_DELIVERY)
    private readonly delivery: VerificationDelivery,
    @Inject(VERIFICATION_CONFIG) private readonly config: VerificationConfig,
  ) {}

  private digest(
    userId: string,
    channel: Channel,
    requestId: string,
    code: string,
  ): string {
    if (!this.config.secret)
      throw new RegistrationError('verification_unavailable', 503);
    return createHmac('sha256', this.config.secret)
      .update(`${userId}:${channel}:${requestId}:${code}`)
      .digest('hex');
  }

  async describe(user: User) {
    const rows = await this.store.challengeStatus(user.id);
    const channel = (name: Channel) => {
      const row = rows.find((r) => r.channel === name);
      const verified =
        name === 'email' ? user.emailVerified : user.phoneVerified;
      return {
        state: verified
          ? ('verified' as const)
          : (row?.send_state ??
            (this.delivery.available(name)
              ? ('ready' as const)
              : ('unavailable' as const))),
        retryAfterSeconds: verified ? 0 : (row?.retry_after ?? 0),
        available: this.delivery.available(name),
        expiresAt: row?.expires_at.toISOString() ?? null,
      };
    };
    const email = channel('email'),
      phone = channel('phone');
    return {
      ...user,
      delivery: { email: email.state, phone: phone.state },
      verification: { email, phone },
    };
  }

  async current(userId: string) {
    const user = await this.store.findUser(userId);
    if (!user) throw new RegistrationError('registration_session_expired', 401);
    return this.describe(user);
  }

  async send(
    userId: string,
    channel: Channel,
    initialOnly = false,
  ): Promise<void> {
    if (!this.delivery.available(channel)) {
      if (initialOnly) return;
      throw new RegistrationError('verification_unavailable', 503);
    }
    const code = randomInt(0, 1000000).toString().padStart(6, '0');
    const requestId = randomUUID();
    const destination = await this.store.reserveCode({
      userId,
      channel,
      requestId,
      digest: this.digest(userId, channel, requestId, code),
      initialOnly,
    });
    if (!destination) return;
    let success = false;
    try {
      await this.delivery.send({ channel, destination, code, requestId });
      success = true;
    } catch {
      /* Provider errors may contain secrets or the entire SMS; never log them. */
    }
    await this.store.finishSend(userId, channel, requestId, success);
    if (!success && !initialOnly)
      throw new RegistrationError('verification_unavailable', 503);
  }

  async initialize(userId: string) {
    await Promise.all(
      (['email', 'phone'] as const).map((channel) =>
        this.send(userId, channel, true),
      ),
    );
    return this.current(userId);
  }

  async verify(userId: string, channel: Channel, code: string) {
    const valid = await this.store.verifyCode(userId, channel, (requestId) =>
      this.digest(userId, channel, requestId, code),
    );
    if (!valid) throw new RegistrationError('verification_invalid_code', 400);
    return this.current(userId);
  }
}
