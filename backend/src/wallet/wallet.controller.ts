import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readCookie } from '../registration/account-session';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import { tokenDigest } from '../registration/registration.service';
import {
  AmountOperationDto,
  CapitalDto,
  HouseMatchFilterDto,
  ProviderDto,
  ReviewDto,
  WalletOperationDto,
  WithdrawalFilterDto,
  WithdrawalIdDto,
} from './wallet.dto';
import { WalletError } from './wallet-error';
import { WalletStore } from './wallet.store';

@Controller('wallet/v1')
export class WalletController {
  constructor(
    @Inject(WalletStore) private readonly store: WalletStore,
    @Inject(REGISTRATION_SETTINGS)
    private readonly settings: RegistrationSettings,
  ) {}

  private session(
    request: FastifyRequest,
    reply: FastifyReply,
    write = false,
  ): string {
    reply.header('cache-control', 'no-store');
    if (
      write &&
      (request.headers.origin !== this.settings.appOrigin ||
        request.headers['x-skillbetting-client'] !== 'web-v1')
    )
      throw new WalletError('origin_rejected', 403);
    const raw = readCookie(
      request,
      this.settings.secureCookie ? '__Host-sb_session' : 'sb_session',
    );
    if (!raw || !/^[a-f0-9]{64}$/.test(raw))
      throw new WalletError('account_session_expired', 401);
    return tokenDigest(raw);
  }

  @Get('balance')
  balance(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.balance(this.session(req, reply));
  }
  @Get('transactions')
  history(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.history(this.session(req, reply));
  }
  @Get('deposits')
  deposits(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.deposits(this.session(req, reply));
  }
  @Post('deposits')
  deposit(
    @Body() input: AmountOperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.createDeposit(
      this.session(req, reply, true),
      input.operationId,
      input.amountMinor,
    );
  }
  @Get('withdrawals')
  withdrawals(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.withdrawals(this.session(req, reply));
  }
  @Post('withdrawals')
  withdraw(
    @Body() input: AmountOperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.requestWithdrawal(
      this.session(req, reply, true),
      input.operationId,
      input.amountMinor,
    );
  }
  @Post('withdrawals/:withdrawalId/cancel')
  cancel(
    @Param() params: WithdrawalIdDto,
    @Body() input: WalletOperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.cancelWithdrawal(
      this.session(req, reply, true),
      input.operationId,
      params.withdrawalId,
    );
  }

  /** Called by the payment provider; authenticated only by its signature. */
  @Post('providers/:provider/webhook')
  @HttpCode(200)
  webhook(
    @Param() params: ProviderDto,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ) {
    return this.store.handleWebhook(params.provider, req.rawBody, req.headers);
  }
}

@Controller('wallet/v1/admin')
export class WalletAdminController {
  constructor(@Inject(WalletStore) private readonly store: WalletStore) {}

  private admin(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    this.store.authorizeAdmin(request.headers.authorization);
  }

  @Get('summary')
  summary(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.summary();
  }
  @Post('house/capital')
  @HttpCode(200)
  capital(
    @Body() input: CapitalDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.moveCapital(input);
  }
  @Get('house/matches')
  houseMatches(
    @Query() query: HouseMatchFilterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.adminHouseMatches(query.status);
  }
  @Get('withdrawals')
  withdrawals(
    @Query() query: WithdrawalFilterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.adminWithdrawals(query.status);
  }
  @Post('withdrawals/:withdrawalId/approve')
  @HttpCode(200)
  approve(
    @Param() params: WithdrawalIdDto,
    @Body() input: ReviewDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.approveWithdrawal(
      params.withdrawalId,
      input.reviewer,
      input.note,
    );
  }
  @Post('withdrawals/:withdrawalId/reject')
  @HttpCode(200)
  reject(
    @Param() params: WithdrawalIdDto,
    @Body() input: ReviewDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.rejectWithdrawal(
      params.withdrawalId,
      input.reviewer,
      input.note,
    );
  }
}
