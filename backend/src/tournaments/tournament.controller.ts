import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readCookie } from '../registration/account-session';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import { tokenDigest } from '../registration/registration.service';
import { GAME_IDS, type GameId } from '../tables/game-catalog';
import { WalletError } from '../wallet/wallet-error';
import { WalletStore } from '../wallet/wallet.store';
import { TournamentStore } from './tournament.store';

class TournamentIdDto {
  @IsUUID() tournamentId!: string;
}
class TournamentOperationDto {
  @IsUUID() operationId!: string;
}
class TournamentConfigDto {
  @IsIn(GAME_IDS) gameId!: GameId;
  @IsString() @Length(1, 80) name!: string;
  @IsInt() @Min(0) @Max(10_000_000) entryFeeMinor!: number;
  @IsInt() @Min(1) @Max(10_000_000) contributionMinor!: number;
  @IsInt() @Min(2) @Max(10_000) minPlayers!: number;
  @IsInt() @Min(2) @Max(10_000) maxPlayers!: number;
  @IsISO8601({ strict: true }) startsAt!: string;
  @IsString() @Length(1, 1000) cancellationPolicy!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10_000, { each: true })
  prizeShares!: number[];
  @IsString() @Length(1, 80) changedBy!: string;
}
class CreateTournamentDto extends TournamentConfigDto {
  @IsUUID() id!: string;
}

@Controller('tournaments/v1')
export class TournamentController {
  constructor(
    @Inject(TournamentStore) private readonly store: TournamentStore,
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

  @Get('tournaments')
  list(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.list(this.session(req, reply));
  }
  @Get('tickets')
  tickets(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.tickets(this.session(req, reply));
  }
  @Get('tournaments/:tournamentId')
  get(
    @Param() params: TournamentIdDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.get(this.session(req, reply), params.tournamentId);
  }
  @Post('tournaments/:tournamentId/tickets')
  buy(
    @Param() params: TournamentIdDto,
    @Body() input: TournamentOperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.buy(
      this.session(req, reply, true),
      input.operationId,
      params.tournamentId,
    );
  }
  @Post('tournaments/:tournamentId/tickets/cancel')
  cancel(
    @Param() params: TournamentIdDto,
    @Body() input: TournamentOperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.cancelTicket(
      this.session(req, reply, true),
      input.operationId,
      params.tournamentId,
    );
  }
}

@Controller('tournaments/v1/admin')
export class TournamentAdminController {
  constructor(
    @Inject(TournamentStore) private readonly store: TournamentStore,
    @Inject(WalletStore) private readonly wallet: WalletStore,
  ) {}

  private admin(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    this.wallet.authorizeAdmin(request.headers.authorization);
  }

  @Get('tournaments')
  dashboard(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.dashboard();
  }
  @Post('tournaments')
  create(
    @Body() input: CreateTournamentDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    const { id, changedBy, ...config } = input;
    return this.store.create(id, config, changedBy);
  }
  @Put('tournaments/:tournamentId')
  update(
    @Param() params: TournamentIdDto,
    @Body() input: TournamentConfigDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    const { changedBy, ...config } = input;
    return this.store.update(params.tournamentId, config, changedBy);
  }
  @Post('tournaments/:tournamentId/start')
  @HttpCode(200)
  start(
    @Param() params: TournamentIdDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.start(params.tournamentId);
  }
  @Post('tournaments/:tournamentId/cancel')
  @HttpCode(200)
  cancel(
    @Param() params: TournamentIdDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.admin(req, reply);
    return this.store.cancel(params.tournamentId);
  }
}
