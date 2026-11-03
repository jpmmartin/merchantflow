import type { IncomingMessage, ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Env } from './modules/config/env.schema.js';
import { replyWithError } from './modules/errors/api/error-reply.js';
import { createUnmatchedRequestLogger } from './modules/logging/logging.module.js';

/** Prefix of every business endpoint (master specification, section 16). */
export const API_PREFIX = 'api/v1';

/** Health probes keep their paths so orchestrators need no API version. */
const UNPREFIXED_PATHS = ['health/live', 'health/ready'];

/** Where the interactive documentation is served outside production. */
export const OPENAPI_UI_PATH = 'docs';

/** Where the OpenAPI document is served outside production. */
export const OPENAPI_JSON_PATH = 'docs/openapi.json';

/**
 * Applies the settings that belong to the application and not to a module:
 * the versioned prefix, outside production the OpenAPI document with its UI,
 * and the answer for paths no route claims. It initializes the application, so
 * it runs once, after the logger is installed. Both `main.ts` and the API tests
 * call it, so they run the same setup.
 */
export async function configureApp(app: INestApplication): Promise<void> {
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_PATHS });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    mountOpenApi(app);
  }
  await app.init();
  replyNotFoundOutsideRoutes(app);
}

/**
 * With a global prefix Nest answers unknown paths only under the prefix and on
 * the excluded health paths, and its logging middleware covers the same paths.
 * Any other path (`/typo`) would get Express's HTML "Cannot GET" page and no
 * access line. This last handler logs the request and gives it the standard
 * error shape. It must be added after `init()` so every route is matched first.
 */
function replyNotFoundOutsideRoutes(app: INestApplication): void {
  const httpAdapter = app.getHttpAdapter();
  const logAccess = createUnmatchedRequestLogger();
  app.use((request: IncomingMessage, response: ServerResponse) => {
    logAccess(request, response, () => {
      replyWithError(httpAdapter, request, response, 'NOT_FOUND');
    });
  });
}

function mountOpenApi(app: INestApplication): void {
  const options = new DocumentBuilder()
    .setTitle('MerchantFlow API')
    .setDescription('Payment orchestration reference platform (sandbox only).')
    .setVersion('1')
    .build();
  SwaggerModule.setup(
    OPENAPI_UI_PATH,
    app,
    () => SwaggerModule.createDocument(app, options),
    { jsonDocumentUrl: OPENAPI_JSON_PATH },
  );
}
