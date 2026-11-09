import {
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';
import type { RegistrationSettings } from '../registration/registration-settings';

/** Advance with a new migration; never rewrite an applied migration. */
export const REQUIRED_SCHEMA_MIGRATION = '013_house_games.sql';

interface ReadinessConnection {
  query(sql: string, values: string[]): Promise<{ rows: { ready: boolean }[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

/** A separate bounded probe cannot queue behind long-running game transactions. */
export class HealthReadiness implements OnModuleDestroy {
  private readonly pool: ReadinessConnection | undefined;

  constructor(
    settings: RegistrationSettings,
    connect: (databaseUrl: string) => ReadinessConnection = (databaseUrl) =>
      new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 1500,
        query_timeout: 1500,
        idleTimeoutMillis: 10_000,
      }),
  ) {
    if (settings.databaseUrl) {
      this.pool = connect(settings.databaseUrl);
      this.pool.on('error', () => {});
    }
  }

  async check(): Promise<{ status: 'ready' }> {
    try {
      const result = await this.pool?.query(
        'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1) AS ready',
        [REQUIRED_SCHEMA_MIGRATION],
      );
      if (result?.rows[0]?.ready === true) return { status: 'ready' };
    } catch {
      // Connection details and database errors must not become public/log data.
    }
    throw new ServiceUnavailableException();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
