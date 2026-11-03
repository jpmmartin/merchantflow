import { randomUUID } from 'node:crypto';
import {
  describeDatabaseFailure,
  getMigrationStatus,
  withTryAdvisoryLock,
  type Database,
} from '@merchantflow/database';
import {
  Module,
  type DynamicModule,
  type INestApplicationContext,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { FindActivePlatformApiKeyService } from '../modules/auth/application/find-active-platform-api-key.service.js';
import { IssueApiKeyService } from '../modules/auth/application/issue-api-key.service.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { ClockModule } from '../modules/clock/clock.module.js';
import type { Env } from '../modules/config/env.schema.js';
import { InvalidConfigurationError } from '../modules/config/validate-env.js';
import {
  DATABASE,
  DatabaseModule,
} from '../modules/database/database.module.js';
import { createLoggerParams } from '../modules/logging/logging.module.js';

export interface SeedCliOptions {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

const SUCCESS = 0;
const FAILURE = 1;

/** Name recorded as the actor of the seed's audit event. */
const SEED_ACTOR_ID = 'dev-seed';

/** Advisory lock key that serializes concurrent seed runs. */
const SEED_LOCK_KEY = 7_301_001;

type SeedOutcome =
  | { readonly kind: 'created'; readonly key: string }
  | {
      readonly kind: 'exists';
      readonly apiKeyId: string;
      readonly createdAt: Date;
    };

/** Dependency graph of the seed: no HTTP server, no merchant or other module. */
@Module({})
class SeedModule {
  static register(
    appConfigModule: Type<unknown>,
    logDestination: DestinationStream,
  ): DynamicModule {
    return {
      module: SeedModule,
      imports: [
        appConfigModule,
        LoggerModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) =>
            createLoggerParams(
              config.get('LOG_LEVEL', { infer: true }),
              logDestination,
            ),
        }),
        ClockModule,
        DatabaseModule,
        AuthModule,
      ],
    };
  }
}

/**
 * Creates an application context. `abortOnError` is `false` because Nest
 * otherwise calls `process.abort()` when initialization fails, which would skip
 * the handling of an invalid configuration.
 */
function createContext(module: Type<unknown> | DynamicModule) {
  return NestFactory.createApplicationContext(module, {
    logger: false,
    abortOnError: false,
  });
}

/**
 * Loads the `AppConfigModule` the API uses. The import is dynamic, and the
 * caller handles the validation error, because validation runs as soon as the
 * module is loaded.
 */
async function loadConfigModule(): Promise<Type<unknown>> {
  const { AppConfigModule } =
    await import('../modules/config/config.module.js');
  return AppConfigModule;
}

/**
 * Reads `NODE_ENV` through the configuration module, before any module that
 * could open a database connection exists.
 */
async function readNodeEnv(
  configModule: Type<unknown>,
): Promise<Env['NODE_ENV']> {
  const context = await createContext(configModule);
  try {
    return context
      .get<ConfigService<Env, true>>(ConfigService)
      .get('NODE_ENV', { infer: true });
  } finally {
    await context.close();
  }
}

/**
 * Creates the platform administrator key unless an active platform key exists,
 * while holding a lock so that two simultaneous runs cannot both create one.
 * Resolves with `undefined` when another run holds the lock.
 */
async function seedPlatformKey(
  context: INestApplicationContext,
): Promise<SeedOutcome | undefined> {
  const database = context.get<Database>(DATABASE);
  const locked = await withTryAdvisoryLock(
    database,
    SEED_LOCK_KEY,
    async (): Promise<SeedOutcome> => {
      const existing = await context
        .get(FindActivePlatformApiKeyService)
        .execute();
      if (existing !== undefined) {
        return {
          kind: 'exists',
          apiKeyId: existing.id,
          createdAt: existing.createdAt,
        };
      }
      const issued = await context.get(IssueApiKeyService).execute({
        actor: { actorType: 'SYSTEM', actorId: SEED_ACTOR_ID },
        scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
        correlationId: randomUUID(),
      });
      if (!issued.ok) {
        // A platform key has no merchant, so this outcome cannot occur.
        throw new Error(`unexpected issuance outcome ${issued.code}`);
      }
      return { kind: 'created', key: issued.key };
    },
  );
  return locked.acquired ? locked.value : undefined;
}

/**
 * Creates the development platform administrator key and prints it once.
 * Resolves with the process exit code: 0 when the key was created or an active
 * platform key already exists, 1 on any failure and in production.
 *
 * The full key is written only to `stdout`, and only here. It is never logged,
 * audited, or stored; the database holds its hash. Failures are reported as a
 * short message and a cause label, never with the connection URL or a database
 * error message.
 */
export async function runSeedCli(options: SeedCliOptions): Promise<number> {
  let configModule: Type<unknown>;
  let nodeEnv: Env['NODE_ENV'];
  try {
    configModule = await loadConfigModule();
    nodeEnv = await readNodeEnv(configModule);
  } catch (error) {
    if (error instanceof InvalidConfigurationError) {
      options.stderr.write(`${error.message}\n`);
      return FAILURE;
    }
    throw error;
  }
  if (nodeEnv === 'production') {
    options.stderr.write(
      'Refusing to seed: NODE_ENV is "production". The development seed runs only in development and test.\n',
    );
    return FAILURE;
  }

  const context = await createContext(
    SeedModule.register(configModule, {
      write: (line) => void options.stderr.write(line),
    }),
  );
  try {
    const database = context.get<Database>(DATABASE);
    try {
      const status = await getMigrationStatus(database);
      if (status.pending.length > 0) {
        options.stderr.write(
          `The database is not migrated: ${status.pending.length} migration(s) pending. Run "pnpm db:migrate" first.\n`,
        );
        return FAILURE;
      }
    } catch (error) {
      options.stderr.write(
        `The database could not be read (cause: ${describeDatabaseFailure(error)}). Check that PostgreSQL is running and that DATABASE_URL points at it.\n`,
      );
      return FAILURE;
    }

    let outcome: SeedOutcome | undefined;
    try {
      outcome = await seedPlatformKey(context);
    } catch (error) {
      options.stderr.write(
        `The seed failed (cause: ${describeDatabaseFailure(error)}). Run it again; it creates nothing twice.\n`,
      );
      return FAILURE;
    }
    if (outcome === undefined) {
      options.stderr.write(
        'Another seed run is in progress. Wait for it to finish and run the seed again.\n',
      );
      return FAILURE;
    }
    if (outcome.kind === 'exists') {
      options.stdout.write(
        `An active platform administrator key already exists (id ${outcome.apiKeyId}, created ${outcome.createdAt.toISOString()}). Nothing was changed.\n` +
          'A stored key cannot be shown again. If it is lost, see "Recover a lost platform key" in the README.\n',
      );
      return SUCCESS;
    }
    options.stdout.write(
      'Platform administrator API key created (role PLATFORM_ADMIN).\n' +
        'Store it now: it is shown only once and cannot be recovered.\n' +
        '\n' +
        `  ${outcome.key}\n` +
        '\n' +
        'Send it as "Authorization: Bearer <key>".\n',
    );
    return SUCCESS;
  } finally {
    await context.close();
  }
}
