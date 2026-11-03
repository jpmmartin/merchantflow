import type { IncomingMessage, ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { resolveCorsOrigins } from './modules/config/cors-origins.js';
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

/** Request headers a browser caller may send cross-origin. */
const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
];

/** Response headers a browser caller may read cross-origin. */
const CORS_EXPOSED_HEADERS = ['Retry-After', 'X-Correlation-Id'];

/**
 * Applies the settings that belong to the application and not to a module:
 * the versioned prefix, CORS for the configured browser origins, outside
 * production the OpenAPI document with its UI, and the answer for paths no
 * route claims. It initializes the application, so
 * it runs once, after the logger is installed. Both `main.ts` and the API tests
 * call it, so they run the same setup.
 */
export async function configureApp(app: INestApplication): Promise<void> {
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_PATHS });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  enableCors(app, config);
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    mountOpenApi(app);
  }
  await app.init();
  replyNotFoundOutsideRoutes(app);
}

/**
 * Allows exactly the configured origins, compared as strings. Credentials are
 * not allowed: the browser sends its token in the `Authorization` header, never
 * in a cookie. An origin outside the list gets no CORS headers, so the browser
 * withholds the response; the request itself is still authenticated as usual.
 */
function enableCors(
  app: INestApplication,
  config: ConfigService<Env, true>,
): void {
  app.enableCors({
    origin: [
      ...resolveCorsOrigins({
        NODE_ENV: config.get('NODE_ENV', { infer: true }),
        CORS_ALLOWED_ORIGINS: config.get('CORS_ALLOWED_ORIGINS', {
          infer: true,
        }),
      }),
    ],
    methods: ['GET', 'HEAD', 'POST', 'PATCH'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    credentials: false,
  });
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
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key or session token',
        description:
          'An API key issued by POST /merchants/{id}/api-keys, or a session token returned by POST /auth/login, sent as Authorization: Bearer <token>.',
      },
      'bearer',
    )
    .build();
  SwaggerModule.setup(
    OPENAPI_UI_PATH,
    app,
    () => SwaggerModule.createDocument(app, options),
    { jsonDocumentUrl: OPENAPI_JSON_PATH },
  );
}
