import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { findApiKeyById } from '../infrastructure/api-key-queries.js';
import type { ApiKey } from './api-key.js';

/**
 * What other modules may know about a stored key. It has neither the hash nor
 * the lookup id, so nothing that could help guess or recognize a key leaves the
 * auth module.
 */
export type ApiKeySummary = Pick<
  ApiKey,
  'id' | 'scope' | 'createdAt' | 'revokedAt'
>;

/** Reads a key's non-sensitive description by its row id. */
@Injectable()
export class FindApiKeyService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(apiKeyId: string): Promise<ApiKeySummary | undefined> {
    const apiKey = await findApiKeyById(this.database, apiKeyId);
    if (apiKey === undefined) return undefined;
    return {
      id: apiKey.id,
      scope: apiKey.scope,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    };
  }
}
