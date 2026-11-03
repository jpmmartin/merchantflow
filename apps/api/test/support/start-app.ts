import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { vi } from 'vitest';

export interface LogLine {
  level: number;
  msg?: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Creates the whole application against a database URL and captures its log
 * output. The configuration is validated when the application module is
 * imported, so the module is imported only after the environment is set.
 *
 * Use one application per test file: `nestjs-pino` keeps a logger for the whole
 * process, so a second application would write its out-of-request lines to the
 * first one's output.
 */
export async function startApp(databaseUrl: string) {
  vi.stubEnv('DATABASE_URL', databaseUrl);
  vi.stubEnv('LOG_LEVEL', 'info');
  const [{ AppModule }, { LOG_DESTINATION }] = await Promise.all([
    import('../../src/app.module.js'),
    import('../../src/modules/logging/logging.module.js'),
  ]);
  const output: string[] = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_DESTINATION)
    .useValue({ write: (chunk: string) => void output.push(chunk) })
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  await app.init();
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
