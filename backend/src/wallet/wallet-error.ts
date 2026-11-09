import { HttpException } from '@nestjs/common';

export type WalletCode =
  | 'account_session_expired'
  | 'origin_rejected'
  | 'wallet_unavailable'
  | 'account_not_eligible'
  | 'invalid_amount'
  | 'insufficient_funds'
  | 'withdrawal_limit_reached'
  | 'withdrawal_share_exceeded'
  | 'operation_conflict'
  | 'withdrawal_not_found'
  | 'withdrawal_state_conflict'
  | 'provider_not_found'
  | 'invalid_signature'
  | 'admin_unauthorized'
  | 'house_offer_unavailable'
  | 'house_reserve_insufficient'
  | 'house_match_active'
  | 'house_match_not_found'
  | 'house_match_settled'
  | 'invalid_tournament'
  | 'tournament_not_found'
  | 'tournament_unavailable'
  | 'tournament_full'
  | 'tournament_locked'
  | 'tournament_underfilled'
  | 'already_registered'
  | 'not_registered'
  | 'invalid_ranking';

export class WalletError extends HttpException {
  constructor(
    readonly code: WalletCode,
    status: number,
  ) {
    super(code, status);
  }
}
