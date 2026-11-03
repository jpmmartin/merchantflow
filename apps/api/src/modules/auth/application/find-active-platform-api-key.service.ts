import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { findActivePlatformApiKey } from '../infrastructure/api-key-queries.js';
import type { ApiKeySummary } from './find-api-key.service.js';

/** Finds the oldest active platform key, without its hash or lookup id. */
@Injectable()
export class FindActivePlatformApiKeyService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(): Promise<ApiKeySummary | undefined> {
    const apiKey = await findActivePlatformApiKey(this.database);
    if (apiKey === undefined) return undefined;
    return {
      id: apiKey.id,
      scope: apiKey.scope,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    };
  }
}
