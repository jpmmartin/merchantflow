import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { listApiKeysOfMerchant } from '../infrastructure/api-key-queries.js';
import type { ApiKeySummary } from './find-api-key.service.js';

/**
 * Reads the keys of a merchant, revoked ones included, oldest first. Each key
 * is summarized, so neither the hash nor the lookup id leaves the auth module.
 */
@Injectable()
export class ListApiKeysService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(merchantId: string): Promise<ApiKeySummary[]> {
    const apiKeys = await listApiKeysOfMerchant(this.database, merchantId);
    return apiKeys.map((apiKey) => ({
      id: apiKey.id,
      scope: apiKey.scope,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    }));
  }
}
