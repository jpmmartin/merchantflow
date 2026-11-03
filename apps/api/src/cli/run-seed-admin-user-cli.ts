import { randomBytes, randomUUID } from 'node:crypto';
import {
  describeDatabaseFailure,
  withTryAdvisoryLock,
  type Database,
} from '@merchantflow/database';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateUserService } from '../modules/auth/application/create-user.service.js';
import { FindPlatformUserService } from '../modules/auth/application/find-platform-user.service.js';
import type { Env } from '../modules/config/env.schema.js';
import { DATABASE } from '../modules/database/database.module.js';
import {
  FAILURE,
  SEED_ACTOR_ID,
  SEED_LOCK_KEY,
  SUCCESS,
  openSeedContext,
  type SeedCliOptions,
} from './seed-context.js';

/** Email of the seeded administrator when `SEED_ADMIN_EMAIL` is not set. */
export const DEFAULT_SEED_ADMIN_EMAIL = 'admin@merchantflow.test';

const SEED_ADMIN_DISPLAY_NAME = 'Platform Administrator';

/** 18 random bytes, printed as 24 base64url characters (144 bits). */
const GENERATED_PASSWORD_BYTES = 18;

type SeedUserOutcome =
  | {
      readonly kind: 'created';
      readonly email: string;
      readonly password: string;
    }
  | {
      readonly kind: 'exists';
      readonly userId: string;
      readonly email: string;
      readonly createdAt: Date;
    };

/**
 * Creates the platform administrator user unless a platform user exists,
 * enabled or not, while holding the seed lock. Resolves with `undefined` when
 * another run holds the lock.
 */
async function seedPlatformUser(
  context: INestApplicationContext,
): Promise<SeedUserOutcome | undefined> {
  const database = context.get<Database>(DATABASE);
  const email =
    context
      .get<ConfigService<Env, true>>(ConfigService)
      .get('SEED_ADMIN_EMAIL', { infer: true }) ?? DEFAULT_SEED_ADMIN_EMAIL;
  const locked = await withTryAdvisoryLock(
    database,
    SEED_LOCK_KEY,
    async (): Promise<SeedUserOutcome> => {
      const existing = await context.get(FindPlatformUserService).execute();
      if (existing !== undefined) {
        return {
          kind: 'exists',
          userId: existing.id,
          email: existing.email,
          createdAt: existing.createdAt,
        };
      }
      const password = randomBytes(GENERATED_PASSWORD_BYTES).toString(
        'base64url',
      );
      const created = await context.get(CreateUserService).execute({
        actor: { actorType: 'SYSTEM', actorId: SEED_ACTOR_ID },
        email,
        displayName: SEED_ADMIN_DISPLAY_NAME,
        scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
        password,
        correlationId: randomUUID(),
      });
      if (!created.ok) {
        throw new Error(
          `the administrator user was not created: ${created.code}`,
        );
      }
      return { kind: 'created', email: created.user.email, password };
    },
  );
  return locked.acquired ? locked.value : undefined;
}

/**
 * Creates the development platform administrator user and prints its
 * generated password once. Resolves with the process exit code: 0 when the
 * user was created or a platform user already exists, 1 on any failure and in
 * production.
 *
 * The password is written only to `stdout`, and only here. It is never logged,
 * audited, or stored; the database holds its scrypt hash.
 */
export async function runSeedAdminUserCli(
  options: SeedCliOptions,
): Promise<number> {
  const opened = await openSeedContext(options);
  if (!opened.ok) return opened.exitCode;
  const { context } = opened;
  try {
    let outcome: SeedUserOutcome | undefined;
    try {
      outcome = await seedPlatformUser(context);
    } catch (error) {
      options.stderr.write(
        `The administrator user seed failed (cause: ${describeDatabaseFailure(error)}). Run it again; it creates nothing twice.\n`,
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
        `A platform administrator user already exists (id ${outcome.userId}, email ${outcome.email}, created ${outcome.createdAt.toISOString()}). Nothing was changed.\n` +
          'A stored password cannot be shown again. If it is lost, see "Recover a lost administrator password" in the README.\n',
      );
      return SUCCESS;
    }
    options.stdout.write(
      'Platform administrator user created (role PLATFORM_ADMIN).\n' +
        'Store the password now: it is shown only once and cannot be recovered.\n' +
        '\n' +
        `  Email:    ${outcome.email}\n` +
        `  Password: ${outcome.password}\n` +
        '\n' +
        'Sign in with them on the web frontend or through POST /api/v1/auth/login.\n',
    );
    return SUCCESS;
  } finally {
    await context.close();
  }
}
