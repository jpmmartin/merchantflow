import {
  describeDatabaseFailure,
  pingDatabase,
  type Database,
} from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DATABASE } from '../../database/database.module.js';

export type ReadinessReport =
  { readonly status: 'ready' } | { readonly status: 'unavailable' };

/**
 * Reports whether the API can serve requests that need its dependencies. The
 * report names no dependency and no cause; the cause is logged as a code that
 * carries no connection details.
 */
@Injectable()
export class GetReadinessService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GetReadinessService.name);
  }

  async execute(): Promise<ReadinessReport> {
    try {
      await pingDatabase(this.database);
      return { status: 'ready' };
    } catch (error) {
      // Any failure of the ping means the database cannot be used right now,
      // whatever its cause, so the error becomes the typed outcome.
      this.logger.warn(
        { reason: describeDatabaseFailure(error) },
        'readiness check failed',
      );
      return { status: 'unavailable' };
    }
  }
}
