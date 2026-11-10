import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  VERIFICATION_CONFIG,
  type VerificationConfig,
} from '../registration/verification-delivery';
import { WALLET_SETTINGS, type WalletSettings } from './wallet-settings';
import { WalletStore } from './wallet.store';

/** Unattended daily reconciliation and notification delivery. */
@Injectable()
export class WalletJobs implements OnModuleInit, OnModuleDestroy {
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(WalletStore) private readonly store: WalletStore,
    @Inject(WALLET_SETTINGS) private readonly settings: WalletSettings,
    @Inject(VERIFICATION_CONFIG) private readonly mail: VerificationConfig,
  ) {}

  onModuleInit(): void {
    const hours = this.settings.reconcileIntervalHours;
    if (hours && this.store.hasProviders())
      this.every(hours * 3_600_000, () =>
        this.store.runScheduledReconciliation(),
      );
    const seconds = this.settings.notifyIntervalSeconds;
    if (seconds && this.mail.resendKey)
      this.every(seconds * 1000, () =>
        this.store.dispatchNotifications((message) => this.email(message)),
      );
  }
  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  private every(ms: number, job: () => Promise<unknown>) {
    // Failures are retried on the next tick; the job itself records outcomes.
    const run = () => void job().catch(() => {});
    this.timers.push(setTimeout(run, 30_000).unref());
    this.timers.push(setInterval(run, ms).unref());
  }

  private async email(message: {
    id: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${this.mail.resendKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `notification/${message.id}`,
      },
      body: JSON.stringify({
        from: this.mail.resendFrom,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) throw new Error('delivery_failed');
  }
}
