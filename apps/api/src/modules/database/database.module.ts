import {
  createDatabase,
  describeDatabaseFailure,
  type Database,
} from '@merchantflow/database';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema.js';

/** Injection token of the Kysely instance that every module shares. */
export const DATABASE = Symbol('DATABASE');

/**
 * Provides the database and closes its pool when the application shuts down.
 * The pool is created without connecting, so the API starts while PostgreSQL
 * is down and reports it through `/health/ready` instead.
 */
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService, PinoLogger],
      useFactory: (
        config: ConfigService<Env, true>,
        logger: PinoLogger,
      ): Database => {
        logger.setContext('Database');
        return createDatabase({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          applicationName: 'merchantflow-api',
          // The label is a code or a fixed word. The error message is left out
          // because it can carry the host and the port.
          onConnectionError: (error) =>
            logger.warn(
              { reason: describeDatabaseFailure(error) },
              'database connection failed',
            ),
        });
      },
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DatabaseModule.name);
  }

  // Runs after the HTTP server has stopped, so no request is still using the
  // pool. Closing waits for connections that are checked out.
  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
    this.logger.info('database pool closed');
  }
}
