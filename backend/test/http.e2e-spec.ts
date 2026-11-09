import { VERIFICATION_CONFIG } from '../src/registration/verification-delivery';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  type LoggerService,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { IsNotEmpty, IsString } from 'class-validator';
import { AppModule } from '../src/app.module';
import { HealthReadiness } from '../src/health/health-readiness';
import { configureApplication, createHttpAdapter } from '../src/bootstrap';
import {
  MATCH_REPOSITORY,
  MatchConcurrencyError,
} from '../src/matches/application/match.repository';
import {
  MatchNotFoundError,
  RecordMatchResultService,
} from '../src/matches/application/record-match-result.service';
import {
  Match,
  MatchDomainError,
  type MatchSnapshot,
} from '../src/matches/domain/match';
import { InMemoryMatchRepository } from './support/in-memory-match.repository';

class RecordResultDto {
  @IsString()
  @IsNotEmpty()
  operationId!: string;

  @IsString()
  @IsNotEmpty()
  winnerId!: string;
}

// These routes exist only in the test application, never in AppModule.
@Controller('test')
class TestController {
  @Get('failure')
  fail(): never {
    throw new Error('private-database-secret');
  }

  @Get('items/:itemId')
  item(): { ok: true } {
    return { ok: true };
  }
}

/** Fixture transport: a real controller must establish authorization and actor identity. */
@Controller('test/matches')
class MatchTestController {
  constructor(
    @Inject(RecordMatchResultService)
    private readonly recordResult: RecordMatchResultService,
  ) {}

  @Post(':matchId/results')
  async record(
    @Param('matchId') matchId: string,
    @Body() input: RecordResultDto,
  ): Promise<MatchSnapshot> {
    try {
      return await this.recordResult.execute({
        matchId,
        ...input,
        actorId: 'trusted-test-actor',
      });
    } catch (error: unknown) {
      if (error instanceof MatchNotFoundError) {
        throw new NotFoundException();
      }
      if (error instanceof MatchDomainError) {
        if (error.code === 'invalid_result') {
          throw new BadRequestException();
        }
        throw new ConflictException();
      }
      if (error instanceof MatchConcurrencyError) {
        throw new ConflictException();
      }
      throw error;
    }
  }
}

class CapturingLogger implements LoggerService {
  readonly entries: unknown[] = [];
  log(message: unknown): void {
    this.entries.push(message);
  }
  error(message: unknown): void {
    this.entries.push(message);
  }
  warn(message: unknown): void {
    this.entries.push(message);
  }
}

void describe('HTTP application', () => {
  let app: NestFastifyApplication;
  const logger = new CapturingLogger();
  let ready = false;
  const repository = new InMemoryMatchRepository([
    new Match('fixture-match', ['player-one', 'player-two']),
    new Match('validation-match', ['player-one', 'player-two']),
  ]);

  before(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestController, MatchTestController],
      providers: [
        RecordMatchResultService,
        { provide: MATCH_REPOSITORY, useValue: repository },
      ],
    })
      .overrideProvider(HealthReadiness)
      .useValue({
        check: () => {
          if (!ready) return Promise.reject(new ServiceUnavailableException());
          return Promise.resolve({ status: 'ready' });
        },
      })
      .overrideProvider(VERIFICATION_CONFIG)
      .useValue({
        secret: undefined,
        resendKey: undefined,
        sevenKey: undefined,
        resendFrom: '',
        sevenSender: 'SkillBet',
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApplication(app, logger);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  after(async () => {
    await app.close();
  });

  void it('exposes a liveness endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.match(String(response.headers['x-request-id']), /^[a-f0-9-]{36}$/);
  });

  void it('exposes noncached readiness independently of process liveness', async () => {
    const missing = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.headers['cache-control'], 'no-store');
    assert.equal(
      missing.json<{ message: string }>().message,
      'Service Unavailable',
    );
    ready = true;
    try {
      const available = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });
      assert.equal(available.statusCode, 200);
      assert.deepEqual(available.json(), { status: 'ready' });
      assert.equal(available.headers['cache-control'], 'no-store');
    } finally {
      ready = false;
    }
  });

  void it('returns standardized errors for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/missing' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      statusCode: 404,
      error: 'Not Found',
      message: 'Not Found',
      requestId: response.headers['x-request-id'],
    });
  });

  void it('does not expose a match result write endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/matches/one/results',
      payload: { winnerId: 'one' },
    });
    assert.equal(response.statusCode, 404);
  });

  void it('accepts DTOs and rejects invalid or unexpected properties', async () => {
    const valid = await app.inject({
      method: 'POST',
      url: '/test/matches/validation-match/results',
      payload: { operationId: 'validation-operation', winnerId: 'player-one' },
    });
    assert.equal(valid.statusCode, 201);
    assert.equal(
      valid.json<MatchSnapshot>().results[0]?.winnerId,
      'player-one',
    );

    for (const payload of [
      { operationId: 'validation-operation', winnerId: 123 },
      { operationId: 'validation-operation', winnerId: '' },
      {
        operationId: 'validation-operation',
        winnerId: 'player-one',
        extra: true,
      },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/test/matches/validation-match/results',
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<{ message: string }>().message, 'Bad Request');
    }
  });

  void it('coordinates HTTP → service → domain → repository using fixture-only transport', async () => {
    const initial = await app.inject({
      method: 'POST',
      url: '/test/matches/fixture-match/results',
      payload: { operationId: 'initial-operation', winnerId: 'player-one' },
    });
    assert.equal(initial.statusCode, 201);
    const stored = await repository.findById('fixture-match');
    assert.equal(stored?.status, 'result_recorded');
    assert.equal(
      stored?.toSnapshot().results[0]?.recordedBy,
      'trusted-test-actor',
    );

    const retry = await app.inject({
      method: 'POST',
      url: '/test/matches/fixture-match/results',
      payload: { operationId: 'initial-operation', winnerId: 'player-one' },
    });
    assert.deepEqual(retry.json(), initial.json());

    const replacement = await app.inject({
      method: 'POST',
      url: '/test/matches/fixture-match/results',
      payload: { operationId: 'replacement-operation', winnerId: 'player-two' },
    });
    assert.equal(replacement.statusCode, 409);
    assert.deepEqual(
      (await repository.findById('fixture-match'))?.toSnapshot(),
      stored?.toSnapshot(),
    );
  });

  void it('normalizes malformed JSON and unsupported content types', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/test/matches/fixture-match/results',
      headers: { 'content-type': 'application/json' },
      payload: '{"private":',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json<{ statusCode: number }>().statusCode, 400);

    const unsupported = await app.inject({
      method: 'POST',
      url: '/test/matches/fixture-match/results',
      headers: { 'content-type': 'application/xml' },
      payload: '<private/>',
    });
    assert.equal(unsupported.statusCode, 415);
    assert.equal(unsupported.json<{ statusCode: number }>().statusCode, 415);
  });

  void it('limits request bodies', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/matches/fixture-match/results',
      payload: { winnerId: 'x'.repeat(1_048_576) },
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json<{ statusCode: number }>().statusCode, 413);
  });

  void it('sanitizes unexpected errors in responses and logs', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/failure' });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
      requestId: response.headers['x-request-id'],
    });
    assert.ok(
      !JSON.stringify(logger.entries).includes('private-database-secret'),
    );
  });

  void it('logs route templates and ignores client request IDs and sensitive inputs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/items/private-item?token=private-query',
      headers: {
        authorization: 'private-header',
        'x-request-id': 'client-forged-id',
      },
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/private-missing-route?token=private-missing-query',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(missing.statusCode, 404);
    assert.notEqual(response.headers['x-request-id'], 'client-forged-id');
    assert.ok(
      logger.entries.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'route' in entry &&
          entry.route === '/test/items/:itemId',
      ),
    );
    const serialized = JSON.stringify(logger.entries);
    for (const secret of [
      'private-item',
      'private-query',
      'private-header',
      'client-forged-id',
      'private-missing-route',
      'private-missing-query',
    ]) {
      assert.ok(!serialized.includes(secret));
    }
  });
});
