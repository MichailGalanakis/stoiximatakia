import { randomUUID } from 'node:crypto';
import {
  ConsoleLogger,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module';
import type { Environment } from './config/environment';
import { HttpExceptionFilter } from './http/http-exception.filter';
import { configurePlatformLive } from './tables/platform-live';

export function createHttpAdapter(trustedProxyHops: 0 | 1 = 0): FastifyAdapter {
  return new FastifyAdapter({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
    // Only enable for an unpublished backend behind one controlled proxy.
    trustProxy: trustedProxyHops === 1 ? (_address, hop) => hop === 0 : false,
  });
}

export function configureApplication(
  app: NestFastifyApplication,
  logger: LoggerService,
): void {
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(logger));

  configurePlatformLive(app);
  const server: FastifyInstance = app.getHttpAdapter().getInstance();
  server.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });
  server.addHook('onResponse', (request, reply, done) => {
    logger.log({
      event: 'request_completed',
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
    done();
  });
}

export async function createApplication(
  environment: Environment,
): Promise<NestFastifyApplication> {
  const logger = new ConsoleLogger({
    json: true,
    logLevels: environment.logLevels,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createHttpAdapter(environment.trustedProxyHops),
    { logger, bufferLogs: true },
  );
  configureApplication(app, logger);
  app.enableShutdownHooks();
  return app;
}
