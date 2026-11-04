import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { vi } from 'vitest';
import { configureApp } from '../../src/app.setup.js';
import { ApiHttpAdapter } from '../../src/modules/errors/api/api-http-adapter.js';
import type { Clock } from '../../src/modules/clock/clock.js';

/**
 * Fixed master key of the processor account secrets in API tests: 32 bytes in
 * base64. It encrypts only test fixtures, so it is not a secret, and it lets
 * the application start in production mode too, which requires a key.
 */
export const TEST_CREDENTIALS_MASTER_KEY = Buffer.from(
  'merchantflow-test-master-key-32b',
  'utf8',
).toString('base64');

export interface LogLine {
  level: number;
  msg?: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Creates the whole application against a database URL and captures its log
 * output. `controllers` adds routes that exist only in a test. The configuration is validated when the application module is
 * imported, so the module is imported only after the environment is set.
 *
 * Use one application per test file: `nestjs-pino` keeps a logger for the whole
 * process, so a second application would write its out-of-request lines to the
 * first one's output.
 */
export async function startApp(
  databaseUrl: string,
  options: {
    readonly clock?: Clock;
    readonly controllers?: Type[];
  } = {},
) {
  vi.stubEnv('DATABASE_URL', databaseUrl);
  vi.stubEnv('LOG_LEVEL', 'info');
  vi.stubEnv('CREDENTIALS_MASTER_KEY', TEST_CREDENTIALS_MASTER_KEY);
  const [{ AppModule }, { LOG_DESTINATION }, { CLOCK }] = await Promise.all([
    import('../../src/app.module.js'),
    import('../../src/modules/logging/logging.module.js'),
    import('../../src/modules/clock/clock.js'),
  ]);
  const output: string[] = [];
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(LOG_DESTINATION)
    .useValue({ write: (chunk: string) => void output.push(chunk) });
  if (options.clock !== undefined) {
    builder = builder.overrideProvider(CLOCK).useValue(options.clock);
  }
  const moduleRef = await builder.compile();
  const app: INestApplication = moduleRef.createNestApplication(
    new ApiHttpAdapter(),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  await configureApp(app);
  return {
    app,
    server: app.getHttpServer() as Server,
    output,
    lines: (): LogLine[] =>
      output
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LogLine),
  };
}
