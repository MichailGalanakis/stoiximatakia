import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { createApplication } from './bootstrap';
import { readEnvironment } from './config/environment';

async function bootstrap(): Promise<void> {
  const environment = readEnvironment();
  const app = await createApplication(environment);
  try {
    await app.listen(environment.port, environment.host);
    console.log(`Server listening at ${await app.getUrl()}`);
  } catch (error: unknown) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch(() => {
  // Do not print arbitrary errors that may contain connection credentials.
  new ConsoleLogger({ json: true }).error({ event: 'startup_failed' });
  process.exitCode = 1;
});
