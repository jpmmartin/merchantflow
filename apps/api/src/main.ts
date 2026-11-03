import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { Env } from './modules/config/env.schema.js';

// Nest buffers its own early logs until Pino takes over, so bootstrap messages
// are emitted as structured JSON instead of being lost or printed in the
// default console format.
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
// SIGTERM and SIGINT then close the application, which stops the HTTP server
// and afterwards closes the database pool.
app.enableShutdownHooks();
const config = app.get<ConfigService<Env, true>>(ConfigService);
await app.listen(
  config.get('PORT', { infer: true }),
  config.get('HOST', { infer: true }),
);
