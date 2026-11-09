import { HttpException } from '@nestjs/common';

export class RegistrationError extends HttpException {
  constructor(
    readonly code:
      | 'invalid_registration'
      | 'terms_changed'
      | 'registration_conflict'
      | 'registration_limited'
      | 'registration_unavailable'
      | 'origin_rejected'
      | 'registration_session_expired'
      | 'account_session_expired'
      | 'invalid_credentials'
      | 'verification_cooldown'
      | 'verification_unavailable'
      | 'verification_invalid_code',
    status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code, status);
  }
}
