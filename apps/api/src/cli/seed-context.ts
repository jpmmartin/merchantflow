import {
  describeDatabaseFailure,
  getMigrationStatus,
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
import { AuthModule } from '../modules/auth/auth.module.js';
import { ClockModule } from '../modules/clock/clock.module.js';
import type { Env } from '../modules/config/env.schema.js';
import { InvalidConfigurationError } from '../modules/config/validate-env.js';
import {
  DATABASE,
  DatabaseModule,
} from '../modules/database/database.module.js';
import { createLoggerParams } from '../modules/logging/logging.module.js';

/** Output streams of a seed command. */
export interface SeedCliOptions {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export const SUCCESS = 0;
export const FAILURE = 1;

/** Name recorded as the actor of the seed's audit events. */
export const SEED_ACTOR_ID = 'dev-seed';

/**
 * Advisory lock key that serializes seed runs: both seed commands take it, so
 * two simultaneous runs cannot both create the same record.
 */
export const SEED_LOCK_KEY = 7_301_001;

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
 * Prepares a seed run: it validates the configuration, refuses production
 * before any database connection exists, builds the seed context with its
 * logs on `stderr`, and checks that the database is migrated. It resolves with
 * the context, which the caller closes, or with the exit code after writing
 * the reason to `stderr`.
 */
export async function openSeedContext(
  options: SeedCliOptions,
): Promise<
  | { readonly ok: true; readonly context: INestApplicationContext }
  | { readonly ok: false; readonly exitCode: number }
> {
  let configModule: Type<unknown>;
  let nodeEnv: Env['NODE_ENV'];
  try {
    configModule = await loadConfigModule();
    nodeEnv = await readNodeEnv(configModule);
  } catch (error) {
    if (error instanceof InvalidConfigurationError) {
      options.stderr.write(`${error.message}\n`);
      return { ok: false, exitCode: FAILURE };
    }
    throw error;
  }
  if (nodeEnv === 'production') {
    options.stderr.write(
      'Refusing to seed: NODE_ENV is "production". The development seed runs only in development and test.\n',
    );
    return { ok: false, exitCode: FAILURE };
  }

  const context = await createContext(
    SeedModule.register(configModule, {
      write: (line) => void options.stderr.write(line),
    }),
  );
  const database = context.get<Database>(DATABASE);
  let failure: string | undefined;
  try {
    const status = await getMigrationStatus(database);
    if (status.pending.length > 0) {
      failure = `The database is not migrated: ${status.pending.length} migration(s) pending. Run "pnpm db:migrate" first.\n`;
    }
  } catch (error) {
    failure = `The database could not be read (cause: ${describeDatabaseFailure(error)}). Check that PostgreSQL is running and that DATABASE_URL points at it.\n`;
  }
  if (failure !== undefined) {
    options.stderr.write(failure);
    await context.close();
    return { ok: false, exitCode: FAILURE };
  }
  return { ok: true, context };
}
