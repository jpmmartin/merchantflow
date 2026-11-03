import { ConfigService } from '@nestjs/config';
import { createApiApplication } from './bootstrap.js';
import type { Env } from './modules/config/env.schema.js';

const app = await createApiApplication();
// SIGTERM and SIGINT then close the application, which stops the HTTP server
// and afterwards closes the database pool.
app.enableShutdownHooks();
const config = app.get<ConfigService<Env, true>>(ConfigService);
await app.listen(
  config.get('PORT', { infer: true }),
  config.get('HOST', { infer: true }),
);
