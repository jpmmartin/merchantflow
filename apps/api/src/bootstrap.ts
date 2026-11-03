import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ApiHttpAdapter } from './modules/errors/api/api-http-adapter.js';

/**
 * Creates and initializes the whole API exactly as the server process runs it,
 * without listening. Nest buffers its own early logs until Pino takes over, so
 * bootstrap messages are emitted as structured JSON instead of being lost or
 * printed in the default console format. The configuration is validated when
 * this module is loaded, so the environment must be set before it is imported.
 */
export async function createApiApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, new ApiHttpAdapter(), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  await configureApp(app);
  return app;
}
