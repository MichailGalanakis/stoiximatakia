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
import type { AdminRole } from './admin';
import {
  AdminNameDto,
  AmountOperationDto,
  AuditQueryDto,
  CapitalDto,
  CorrectionDto,
  CorrectionIdDto,
  CreateAdminDto,
  DecisionDto,
  DisputeIdDto,
  HouseMatchFilterDto,
  OpenDisputeDto,
  ProviderDto,
  ReconcileDto,
  ResolveDisputeDto,
  ReviewDto,
  StatusFilterDto,
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

/**
 * Roles: viewer reads; finance moves money (approvals, capital, corrections,
 * disputes, reconciliation); admin also manages admin accounts.
 */
@Controller('wallet/v1/admin')
export class WalletAdminController {
  constructor(@Inject(WalletStore) private readonly store: WalletStore) {}

  private admin(request: FastifyRequest, reply: FastifyReply, role: AdminRole) {
    reply.header('cache-control', 'no-store');
    return this.store.authorizeAdmin(request.headers.authorization, role);
  }

  @Get('summary')
  async summary(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'viewer');
    return this.store.summary();
  }
  @Post('house/capital')
  @HttpCode(200)
  async capital(
    @Body() input: CapitalDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.moveCapital(input, actor);
  }
  @Get('house/matches')
  async houseMatches(
    @Query() query: HouseMatchFilterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'viewer');
    return this.store.adminHouseMatches(query.status);
  }
  @Get('withdrawals')
  async withdrawals(
    @Query() query: WithdrawalFilterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'viewer');
    return this.store.adminWithdrawals(query.status);
  }
  @Post('withdrawals/:withdrawalId/approve')
  @HttpCode(200)
  async approve(
    @Param() params: WithdrawalIdDto,
    @Body() input: ReviewDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.approveWithdrawal(params.withdrawalId, actor, input.note);
  }
  @Post('withdrawals/:withdrawalId/reject')
  @HttpCode(200)
  async reject(
    @Param() params: WithdrawalIdDto,
    @Body() input: ReviewDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.rejectWithdrawal(params.withdrawalId, actor, input.note);
  }

  @Get('admins')
  async admins(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'admin');
    return this.store.admins();
  }
  @Post('admins')
  async createAdmin(
    @Body() input: CreateAdminDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'admin');
    return this.store.createAdmin(actor, input.name, input.role);
  }
  @Post('admins/:name/deactivate')
  @HttpCode(200)
  async deactivateAdmin(
    @Param() params: AdminNameDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'admin');
    return this.store.deactivateAdmin(actor, params.name);
  }
  @Get('audit')
  async audit(
    @Query() query: AuditQueryDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'viewer');
    return this.store.auditLog(query.limit ?? 100);
  }

  @Get('corrections')
  async corrections(
    @Query() query: StatusFilterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'viewer');
    return this.store.corrections(query.status);
  }
  @Post('corrections')
  async requestCorrection(
    @Body() input: CorrectionDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.requestCorrection(actor, input);
  }
  @Post('corrections/:correctionId/decision')
  @HttpCode(200)
  async decideCorrection(
    @Param() params: CorrectionIdDto,
    @Body() input: DecisionDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.decideCorrection(
      actor,
      params.correctionId,
      input.decision === 'approve',
    );
  }

  @Get('disputes')
  async disputes(
    @Query() query: StatusFilterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'viewer');
    return this.store.disputes(query.status);
  }
  @Post('disputes')
  async openDispute(
    @Body() input: OpenDisputeDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.openDispute(actor, input.depositId, input.reason);
  }
  @Post('disputes/:disputeId/resolve')
  @HttpCode(200)
  async resolveDispute(
    @Param() params: DisputeIdDto,
    @Body() input: ResolveDisputeDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.resolveDispute(
      actor,
      params.disputeId,
      input.outcome,
      input.note,
    );
  }

  @Get('reconciliations')
  async reconciliations(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.admin(req, reply, 'viewer');
    return this.store.reconciliations();
  }
  @Post('reconciliations')
  async reconcile(
    @Body() input: ReconcileDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.admin(req, reply, 'finance');
    return this.store.reconcile(actor, input);
  }
}
