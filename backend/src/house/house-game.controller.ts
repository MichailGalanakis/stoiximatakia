import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
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
import { PlatformError } from '../tables/platform-error';
import { HouseGameStore } from './house-game.store';

class StartHouseGameDto {
  @IsUUID() operationId!: string;
  @IsIn(GAME_IDS) gameId!: GameId;
  @IsString() @Length(1, 40) offerId!: string;
  @IsOptional() @IsString() @Length(1, 16) formatId?: string;
}
class HouseMatchIdDto {
  @IsUUID() matchId!: string;
}
class HouseOperationDto {
  @IsUUID() operationId!: string;
}
class HouseActionDto extends HouseOperationDto {
  @IsInt() @Min(1) @Max(2_147_483_646) expectedRevision!: number;
  @IsObject() action!: Record<string, unknown>;
}

@Controller('house/v1')
export class HouseGameController {
  constructor(
    @Inject(HouseGameStore) private readonly store: HouseGameStore,
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
      throw new PlatformError('origin_rejected', 403);
    const raw = readCookie(
      request,
      this.settings.secureCookie ? '__Host-sb_session' : 'sb_session',
    );
    if (!raw || !/^[a-f0-9]{64}$/.test(raw))
      throw new PlatformError('account_session_expired', 401);
    return tokenDigest(raw);
  }

  @Get('offers')
  offers(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.offers(this.session(req, reply));
  }
  @Post('matches')
  start(
    @Body() input: StartHouseGameDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.start(this.session(req, reply, true), input);
  }
  @Get('matches/:matchId')
  game(
    @Param() params: HouseMatchIdDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.game(this.session(req, reply), params.matchId);
  }
  @Post('matches/:matchId/actions')
  act(
    @Param() params: HouseMatchIdDto,
    @Body() input: HouseActionDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.act(this.session(req, reply, true), {
      ...input,
      matchId: params.matchId,
    });
  }
  @Post('matches/:matchId/forfeit')
  forfeit(
    @Param() params: HouseMatchIdDto,
    @Body() input: HouseOperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.forfeit(
      this.session(req, reply, true),
      input.operationId,
      params.matchId,
    );
  }
}
