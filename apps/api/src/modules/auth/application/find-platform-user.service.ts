import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { findOldestPlatformUser } from '../infrastructure/user-queries.js';
import { summarizeUser, type UserSummary } from './user.js';

/** Finds the oldest platform user, enabled or not, without its password hash. */
@Injectable()
export class FindPlatformUserService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(): Promise<UserSummary | undefined> {
    const user = await findOldestPlatformUser(this.database);
    return user === undefined ? undefined : summarizeUser(user);
  }
}
