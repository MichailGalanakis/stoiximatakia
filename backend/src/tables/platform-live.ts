import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { WebSocket } from 'ws';
import { plainToInstance } from 'class-transformer';
import {
  validateSync,
  IsIn,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { readCookie } from '../registration/account-session';
import { tokenDigest } from '../registration/registration.service';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import { GAME_IDS, type GameId } from './game-catalog';
import { PlatformError } from './platform-error';
import { PlatformStore } from './platform.store';
import {
  CreateTableDto,
  GameActionDto,
  GameOperationDto,
  OperationDto,
  PrivateAccessDto,
  SeatDto,
  TableIdDto,
} from './table.dto';

class LiveMessage {
  @IsUUID() id!: string;
  @IsIn([
    'subscribe',
    'credits',
    'tickets',
    'create',
    'private-access',
    'join',
    'move',
    'cancel',
    'ready',
    'forfeit',
    'action',
  ])
  type!: string;
  @IsOptional() @IsIn(GAME_IDS) gameId?: GameId;
  @IsOptional() @IsUUID() tableId?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}
function checked<T extends object>(type: new () => T, input: unknown): T {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new PlatformError('invalid_table_request', 400);
  const value = plainToInstance(type, input);
  if (
    validateSync(value, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }).length
  )
    throw new PlatformError('invalid_table_request', 400);
  return value;
}
interface LiveClient {
  socket: WebSocket;
  hash: string;
  ip: string;
  gameId: GameId | undefined;
  tableId: string | undefined;
  pending: number;
  refreshRunning: boolean;
  refreshAgain: boolean;
  lastSnapshot: string;
  generation: number;
  windowStart: number;
  received: number;
}

@Injectable()
export class PlatformLive implements OnModuleInit, OnModuleDestroy {
  private readonly clients = new Set<LiveClient>();
  private listener: PoolClient | undefined;
  private releaseListener: (() => void) | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(
    @Inject(PlatformStore) private readonly store: PlatformStore,
    @Inject(REGISTRATION_SETTINGS)
    private readonly settings: RegistrationSettings,
  ) {}

  onModuleInit(): void {
    if (!this.store.pool) return;
    void this.listen();
    // Transport/session restoration, not a game clock or forfeiture deadline.
    // Periodic snapshots repair a missed notification after LISTEN reconnects.
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) void this.refresh(client);
    }, 5000);
    this.heartbeat.unref();
  }
  private async listen(): Promise<void> {
    if (this.stopped || !this.store.pool) return;
    let connection: PoolClient | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.listener === connection) {
        this.listener = undefined;
        this.releaseListener = undefined;
      }
      connection?.release(true);
    };
    const retry = () => {
      release();
      if (!this.stopped && !this.reconnect) {
        this.reconnect = setTimeout(() => {
          this.reconnect = undefined;
          void this.listen();
        }, 1000);
        this.reconnect.unref();
      }
    };
    try {
      connection = await this.store.pool.connect();
      if (this.stopped) {
        release();
        return;
      }
      this.listener = connection;
      this.releaseListener = release;
      connection.on('error', retry);
      connection.on('end', retry);
      connection.on('notification', () => {
        for (const client of this.clients) void this.refresh(client);
      });
      await connection.query('LISTEN platform_updates');
    } catch {
      retry();
    }
  }
  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.releaseListener?.();
  }
  configure(server: FastifyInstance): void {
    server.register(websocket, {
      options: { maxPayload: 16384, perMessageDeflate: false },
    });
    server.after((error) => {
      if (error) throw error;
      server.route({
        method: 'GET',
        url: '/multiplayer/v1/live',
        preValidation: async (request, reply) => {
          try {
            if (request.headers.origin !== this.settings.appOrigin)
              throw new PlatformError('origin_rejected', 403);
            const hash = this.hash(request);
            await this.store.session(hash, async () => {});
          } catch (error) {
            const status =
              error instanceof PlatformError ? error.getStatus() : 503;
            return reply.code(status).send({
              statusCode: status,
              error:
                status === 401
                  ? 'Unauthorized'
                  : status === 403
                    ? 'Forbidden'
                    : 'Service Unavailable',
              message:
                status === 401
                  ? 'Unauthorized'
                  : status === 403
                    ? 'Forbidden'
                    : 'Service Unavailable',
              code:
                error instanceof PlatformError
                  ? error.code
                  : 'platform_unavailable',
              requestId: request.id,
            });
          }
        },
        handler: (_request, reply) =>
          reply.code(426).send({
            statusCode: 426,
            error: 'Upgrade Required',
            message: 'Upgrade Required',
          }),
        wsHandler: (socket, request) =>
          this.attach(socket, this.hash(request), request.ip),
      });
    });
  }
  private hash(request: FastifyRequest): string {
    const raw = readCookie(
      request,
      this.settings.secureCookie ? '__Host-sb_session' : 'sb_session',
    );
    if (!raw || !/^[a-f0-9]{64}$/.test(raw))
      throw new PlatformError('account_session_expired', 401);
    return tokenDigest(raw);
  }
  private send(client: LiveClient, value: unknown): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > 262144) {
      client.socket.close(1013, 'Slow connection');
      return;
    }
    client.socket.send(JSON.stringify(value));
  }
  private fail(client: LiveClient, error: unknown, id?: string): void {
    const code =
      error instanceof PlatformError ? error.code : 'platform_unavailable';
    this.send(client, { type: 'error', ...(id ? { id } : {}), code });
    if (code === 'account_session_expired')
      client.socket.close(1008, 'Session expired');
  }
  private attach(socket: WebSocket, hash: string, ip: string): void {
    if (
      this.clients.size >= 1000 ||
      [...this.clients].filter((c) => c.hash === hash).length >= 8
    ) {
      socket.close(1013, 'Connection limit');
      return;
    }
    const client: LiveClient = {
      socket,
      hash,
      ip,
      gameId: undefined,
      tableId: undefined,
      pending: 0,
      refreshRunning: false,
      refreshAgain: false,
      lastSnapshot: '',
      generation: 0,
      windowStart: Date.now(),
      received: 0,
    };
    this.clients.add(client);
    let queue = Promise.resolve();
    // Attach synchronously before doing any asynchronous work.
    socket.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - client.windowStart >= 60000) {
        client.windowStart = now;
        client.received = 0;
      }
      if (++client.received > 120) {
        socket.close(1008, 'Message limit');
        return;
      }
      if (isBinary || !Buffer.isBuffer(data) || client.pending >= 32) {
        socket.close(1008, 'Invalid message');
        return;
      }
      let message: LiveMessage;
      try {
        message = checked(LiveMessage, JSON.parse(data.toString('utf8')));
      } catch {
        this.fail(client, new PlatformError('invalid_table_request', 400));
        return;
      }
      client.pending++;
      queue = queue.then(async () => {
        try {
          await this.dispatch(client, message);
        } catch (error) {
          this.fail(client, error, message.id);
        } finally {
          client.pending--;
        }
      });
    });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => {
      this.clients.delete(client);
      socket.terminate();
    });
    this.send(client, { type: 'connected', protocol: 'tables-v1' });
  }
  private async dispatch(
    client: LiveClient,
    message: LiveMessage,
  ): Promise<void> {
    const { id, type, tableId, payload } = message;
    let result: unknown;
    if (type === 'subscribe') {
      if (!message.gameId || payload)
        throw new PlatformError('invalid_table_request', 400);
      // Authorize the requested room before retaining a subscription.
      if (
        tableId &&
        (await this.store.get(client.hash, tableId)).table.gameId !==
          message.gameId
      )
        throw new PlatformError('invalid_table_request', 400);
      client.generation++;
      client.gameId = message.gameId;
      client.tableId = tableId;
      client.lastSnapshot = '';
      await this.refresh(client, id);
      return;
    }
    if (type === 'credits') result = await this.store.credits(client.hash);
    else if (type === 'tickets') result = await this.store.tickets(client.hash);
    else if (type === 'create')
      result = await this.store.create(
        client.hash,
        checked(CreateTableDto, payload),
      );
    else if (type === 'private-access')
      result = await this.store.access(
        client.hash,
        checked(PrivateAccessDto, payload).code,
        client.ip,
      );
    else {
      checked(TableIdDto, { tableId });
      if (type === 'join' || type === 'move') {
        const command = checked(SeatDto, payload);
        result = await this.store[type](
          client.hash,
          tableId!,
          command.operationId,
          command.seatIndex,
        );
      } else if (type === 'action') {
        const command = checked(GameActionDto, payload);
        result = await this.store.applyGameAction(
          client.hash,
          tableId!,
          command.operationId,
          command.expectedRevision,
          command.action,
        );
      } else if (type === 'forfeit') {
        const command = checked(GameOperationDto, payload);
        result = await this.store.forfeit(
          client.hash,
          tableId!,
          command.operationId,
          command.expectedRevision,
        );
      } else {
        const command = checked(OperationDto, payload);
        if (type === 'ready')
          result = await this.store.ready(
            client.hash,
            tableId!,
            command.operationId,
          );
        else
          result = await this.store.cancel(
            client.hash,
            tableId!,
            command.operationId,
          );
      }
    }
    this.send(client, { type: 'result', id, result });
  }
  private async refresh(client: LiveClient, id?: string): Promise<void> {
    if (!this.clients.has(client)) return;
    if (client.refreshRunning) {
      client.refreshAgain = true;
      if (id)
        this.send(client, { type: 'result', id, result: { subscribed: true } });
      return;
    }
    client.refreshRunning = true;
    try {
      do {
        client.refreshAgain = false;
        const generation = client.generation,
          gameId = client.gameId,
          tableId = client.tableId;
        if (!gameId) {
          await this.store.credits(client.hash);
          continue;
        }
        const snapshot = await this.store.liveSnapshot(
          client.hash,
          gameId,
          tableId,
        );
        if (generation !== client.generation) {
          client.refreshAgain = true;
          continue;
        }
        const serialized = JSON.stringify(snapshot);
        if (id || serialized !== client.lastSnapshot) {
          this.send(client, {
            type: 'snapshot',
            ...(id ? { id } : {}),
            ...snapshot,
          });
          client.lastSnapshot = serialized;
        }
        id = undefined;
      } while (client.refreshAgain && this.clients.has(client));
    } catch (error) {
      this.fail(client, error, id);
    } finally {
      client.refreshRunning = false;
    }
  }
}

export function configurePlatformLive(app: NestFastifyApplication): void {
  app.get(PlatformLive).configure(app.getHttpAdapter().getInstance());
}
