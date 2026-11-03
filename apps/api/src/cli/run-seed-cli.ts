import { randomUUID } from 'node:crypto';
import {
  describeDatabaseFailure,
  withTryAdvisoryLock,
  type Database,
} from '@merchantflow/database';
import type { INestApplicationContext } from '@nestjs/common';
import { FindActivePlatformApiKeyService } from '../modules/auth/application/find-active-platform-api-key.service.js';
import { IssueApiKeyService } from '../modules/auth/application/issue-api-key.service.js';
import { DATABASE } from '../modules/database/database.module.js';
import {
  FAILURE,
  SEED_ACTOR_ID,
  SEED_LOCK_KEY,
  SUCCESS,
  openSeedContext,
  type SeedCliOptions,
} from './seed-context.js';

export type { SeedCliOptions } from './seed-context.js';

type SeedOutcome =
  | { readonly kind: 'created'; readonly key: string }
  | {
      readonly kind: 'exists';
      readonly apiKeyId: string;
      readonly createdAt: Date;
    };

/**
 * Creates the platform administrator key unless an active platform key exists,
 * while holding a lock so that two simultaneous runs cannot both create one.
 * Resolves with `undefined` when another run holds the lock.
 */
async function seedPlatformKey(
  context: INestApplicationContext,
): Promise<SeedOutcome | undefined> {
  const database = context.get<Database>(DATABASE);
  const locked = await withTryAdvisoryLock(
    database,
    SEED_LOCK_KEY,
    async (): Promise<SeedOutcome> => {
      const existing = await context
        .get(FindActivePlatformApiKeyService)
        .execute();
      if (existing !== undefined) {
        return {
          kind: 'exists',
          apiKeyId: existing.id,
          createdAt: existing.createdAt,
        };
      }
      const issued = await context.get(IssueApiKeyService).execute({
        actor: { actorType: 'SYSTEM', actorId: SEED_ACTOR_ID },
        scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
        correlationId: randomUUID(),
      });
      if (!issued.ok) {
        // A platform key has no merchant, so this outcome cannot occur.
        throw new Error(`unexpected issuance outcome ${issued.code}`);
      }
      return { kind: 'created', key: issued.key };
    },
  );
  return locked.acquired ? locked.value : undefined;
}

/**
 * Creates the development platform administrator key and prints it once.
 * Resolves with the process exit code: 0 when the key was created or an active
 * platform key already exists, 1 on any failure and in production.
 *
 * The full key is written only to `stdout`, and only here. It is never logged,
 * audited, or stored; the database holds its hash. Failures are reported as a
 * short message and a cause label, never with the connection URL or a database
 * error message.
 */
export async function runSeedCli(options: SeedCliOptions): Promise<number> {
  const opened = await openSeedContext(options);
  if (!opened.ok) return opened.exitCode;
  const { context } = opened;
  try {
    let outcome: SeedOutcome | undefined;
    try {
      outcome = await seedPlatformKey(context);
    } catch (error) {
      options.stderr.write(
        `The seed failed (cause: ${describeDatabaseFailure(error)}). Run it again; it creates nothing twice.\n`,
      );
      return FAILURE;
    }
    if (outcome === undefined) {
      options.stderr.write(
        'Another seed run is in progress. Wait for it to finish and run the seed again.\n',
      );
      return FAILURE;
    }
    if (outcome.kind === 'exists') {
      options.stdout.write(
        `An active platform administrator key already exists (id ${outcome.apiKeyId}, created ${outcome.createdAt.toISOString()}). Nothing was changed.\n` +
          'A stored key cannot be shown again. If it is lost, see "Recover a lost platform key" in the README.\n',
      );
      return SUCCESS;
    }
    options.stdout.write(
      'Platform administrator API key created (role PLATFORM_ADMIN).\n' +
        'Store it now: it is shown only once and cannot be recovered.\n' +
        '\n' +
        `  ${outcome.key}\n` +
        '\n' +
        'Send it as "Authorization: Bearer <key>".\n',
    );
    return SUCCESS;
  } finally {
    await context.close();
  }
}
