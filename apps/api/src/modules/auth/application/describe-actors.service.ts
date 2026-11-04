import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { findApiKeysByIds } from '../infrastructure/api-key-queries.js';
import { findUsersByIds } from '../infrastructure/user-queries.js';
import type { ApiKeyScope } from './api-key-scope.js';

/** What may leave the auth module about a user who acted: no hash. */
export interface UserActor {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly scope: ApiKeyScope;
}

/** What may leave the auth module about a key that acted: no lookup id or hash. */
export interface ApiKeyActor {
  readonly id: string;
  readonly scope: ApiKeyScope;
}

export interface ActorDirectory {
  readonly users: ReadonlyMap<string, UserActor>;
  readonly apiKeys: ReadonlyMap<string, ApiKeyActor>;
}

/** Actor IDs of users and keys are UUIDs; anything else names no row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Looks up the users and API keys named as actors of audit events, so other
 * modules can show who acted without reading the auth module's tables. It
 * returns only the display name, email, and scope of a user and the scope of
 * a key: never a password hash, a key's lookup id, or its hash. A missing row
 * (a deleted user) is absent from the maps.
 */
@Injectable()
export class DescribeActorsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(refs: {
    readonly userIds: Iterable<string>;
    readonly apiKeyIds: Iterable<string>;
  }): Promise<ActorDirectory> {
    const userIds = [...new Set(refs.userIds)].filter((id) => UUID.test(id));
    const apiKeyIds = [...new Set(refs.apiKeyIds)].filter((id) =>
      UUID.test(id),
    );
    const [users, apiKeys] = await Promise.all([
      findUsersByIds(this.database, userIds),
      findApiKeysByIds(this.database, apiKeyIds),
    ]);
    return {
      users: new Map(
        users.map((user) => [
          user.id,
          {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
            scope: user.scope,
          },
        ]),
      ),
      apiKeys: new Map(
        apiKeys.map((key) => [key.id, { id: key.id, scope: key.scope }]),
      ),
    };
  }
}
