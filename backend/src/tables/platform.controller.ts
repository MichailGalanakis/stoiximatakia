import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readCookie } from '../registration/account-session';
import { tokenDigest } from '../registration/registration.service';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import { PlatformError } from './platform-error';
import { PlatformStore } from './platform.store';
import {
  CreateTableDto,
  GameActionDto,
  GameSelectionDto,
  GameOperationDto,
  ListTablesDto,
  OperationDto,
  PrivateAccessDto,
  SeatDto,
  TableIdDto,
} from './table.dto';

@Controller('multiplayer/v1')
export class PlatformController {
  constructor(
    @Inject(PlatformStore) private readonly store: PlatformStore,
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
  @Get('credits')
  credits(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.credits(this.session(req, reply));
  }
  @Get('tickets')
  tickets(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.tickets(this.session(req, reply));
  }
  @Get('tables')
  tables(
    @Query() query: ListTablesDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.list(
      this.session(req, reply),
      query.gameId,
      query.currency ?? 'credits',
    );
  }
  @Get('tables/:tableId')
  table(
    @Param() params: TableIdDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.get(this.session(req, reply), params.tableId);
  }
  @Post('tables')
  create(
    @Body() input: CreateTableDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.create(this.session(req, reply, true), input);
  }
  @Post('private-access')
  access(
    @Body() input: PrivateAccessDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.access(
      this.session(req, reply, true),
      input.code,
      req.ip,
    );
  }
  @Post('tables/:tableId/seats')
  join(
    @Param() params: TableIdDto,
    @Body() input: SeatDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.join(
      this.session(req, reply, true),
      params.tableId,
      input.operationId,
      input.seatIndex,
    );
  }
  @Post('tables/:tableId/seat')
  move(
    @Param() params: TableIdDto,
    @Body() input: SeatDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.move(
      this.session(req, reply, true),
      params.tableId,
      input.operationId,
      input.seatIndex,
    );
  }
  @Post('tables/:tableId/cancel')
  cancel(
    @Param() params: TableIdDto,
    @Body() input: OperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.cancel(
      this.session(req, reply, true),
      params.tableId,
      input.operationId,
    );
  }
  @Get('tables/:tableId/match')
  match(
    @Param() params: TableIdDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.match(this.session(req, reply), params.tableId);
  }
  @Post('tables/:tableId/forfeit')
  forfeit(
    @Param() params: TableIdDto,
    @Body() input: GameOperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.forfeit(
      this.session(req, reply, true),
      params.tableId,
      input.operationId,
      input.expectedRevision,
    );
  }
  @Get('tables/:tableId/game')
  game(
    @Param() params: TableIdDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.game(this.session(req, reply), params.tableId);
  }
  @Post('tables/:tableId/actions')
  action(
    @Param() params: TableIdDto,
    @Body() input: GameActionDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.applyGameAction(
      this.session(req, reply, true),
      params.tableId,
      input.operationId,
      input.expectedRevision,
      input.action,
    );
  }
  @Post('tables/:tableId/selection')
  selection(
    @Param() params: TableIdDto,
    @Body() input: GameSelectionDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.previewGameSelection(
      this.session(req, reply, true),
      params.tableId,
      input.expectedRevision,
      input.selection,
    );
  }
  @Post('tables/:tableId/ready')
  ready(
    @Param() params: TableIdDto,
    @Body() input: OperationDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.store.ready(
      this.session(req, reply, true),
      params.tableId,
      input.operationId,
    );
  }
}
