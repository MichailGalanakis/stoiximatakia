import { STATUS_CODES } from 'node:http';
import {
  ArgumentsHost,
  Catch,
  HttpException,
  type ExceptionFilter,
  type LoggerService,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RegistrationError } from '../registration/registration-error';
import { PlatformError } from '../tables/platform-error';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const statusCode = this.statusCode(exception);
    const message = STATUS_CODES[statusCode] ?? 'Internal Server Error';

    if (statusCode >= 500) {
      // Arbitrary exception messages, stacks and request data can contain secrets.
      this.logger.error({
        event: 'request_failed',
        requestId: request.id,
        statusCode,
      });
    }

    if (
      exception instanceof RegistrationError &&
      exception.retryAfterSeconds !== undefined
    )
      reply.header('retry-after', exception.retryAfterSeconds);
    void reply.status(statusCode).send({
      statusCode,
      error: message,
      message,
      requestId: request.id,
      ...(exception instanceof RegistrationError ||
      exception instanceof PlatformError
        ? {
            code: exception.code,
            ...(exception instanceof RegistrationError &&
            exception.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: exception.retryAfterSeconds }
              : {}),
          }
        : {}),
    });
  }

  private statusCode(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    // Fastify parser and body-limit errors occur before controller execution.
    if (
      exception instanceof Error &&
      'statusCode' in exception &&
      typeof exception.statusCode === 'number' &&
      Number.isInteger(exception.statusCode) &&
      exception.statusCode >= 400 &&
      exception.statusCode < 500
    ) {
      return exception.statusCode;
    }
    return 500;
  }
}
