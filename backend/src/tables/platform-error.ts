import { HttpException } from '@nestjs/common';

export type PlatformCode =
  | 'invalid_table_request'
  | 'account_session_expired'
  | 'origin_rejected'
  | 'table_not_found'
  | 'table_full'
  | 'table_unavailable'
  | 'already_participating'
  | 'not_participating'
  | 'seat_unavailable'
  | 'insufficient_credits'
  | 'operation_conflict'
  | 'private_code_unavailable'
  | 'private_code_invalid'
  | 'access_limited'
  | 'engine_unavailable'
  | 'game_not_started'
  | 'stale_game_revision'
  | 'match_ended'
  | 'cancellation_unavailable'
  | 'invalid_game_action'
  | 'platform_unavailable';

export class PlatformError extends HttpException {
  constructor(
    readonly code: PlatformCode,
    status: number,
  ) {
    super(code, status);
  }
}
