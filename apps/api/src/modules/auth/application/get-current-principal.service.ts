import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { findUserById } from '../infrastructure/user-queries.js';
import type { Principal } from './principal.js';
import { summarizeUser, type UserSummary } from './user.js';

export type CurrentPrincipal =
  | { readonly source: 'API_KEY'; readonly principal: Principal }
  | {
      readonly source: 'USER';
      readonly principal: Principal;
      readonly user: UserSummary;
    };

/**
 * Describes the caller of a request. A user principal is completed with the
 * stored user's display name and email; an API key principal has neither.
 */
@Injectable()
export class GetCurrentPrincipalService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(principal: Principal): Promise<CurrentPrincipal> {
    if (principal.source === 'API_KEY') {
      return { source: 'API_KEY', principal };
    }
    const user = await findUserById(this.database, principal.userId);
    if (user === undefined) {
      // The session's foreign key makes a principal without its user
      // impossible while the session row exists.
      throw new Error(`user ${principal.userId} of the principal is missing`);
    }
    return { source: 'USER', principal, user: summarizeUser(user) };
  }
}
