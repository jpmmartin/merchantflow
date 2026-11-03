import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { listUsersOfMerchant } from '../infrastructure/user-queries.js';
import { summarizeUser, type UserSummary } from './user.js';

/**
 * Reads the users of a merchant, enabled or not, oldest first. Each user is
 * summarized, so no password hash leaves the auth module.
 */
@Injectable()
export class ListUsersService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(merchantId: string): Promise<UserSummary[]> {
    const users = await listUsersOfMerchant(this.database, merchantId);
    return users.map(summarizeUser);
  }
}
