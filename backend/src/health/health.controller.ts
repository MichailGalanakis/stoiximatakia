import { Controller, Get, Header, Inject } from '@nestjs/common';
import { HealthReadiness } from './health-readiness';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthReadiness) private readonly readiness: HealthReadiness,
  ) {}

  @Get()
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  getReadiness(): Promise<{ status: 'ready' }> {
    return this.readiness.check();
  }
}
