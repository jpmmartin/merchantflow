import { randomUUID } from 'node:crypto';
import {
  DEFAULT_DATABASE_SETTINGS,
  createDatabase,
  type Database,
  type DatabaseTransaction,
} from '@merchantflow/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClaimIdempotencyKeyOutcome } from '../src/modules/idempotency/application/claim-idempotency-key.service.js';
import {
  claimCommand,
  idempotencyServices,
  insertTestMerchant,
} from './support/idempotency.js';
import {
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const OWNER_APPLICATION = 'idempotency-owner';
const WAITER_APPLICATION = 'idempotency-waiter';
const { queryTimeoutMillis, idleInTransactionSessionTimeoutMillis } =
  DEFAULT_DATABASE_SETTINGS;
// Each statement of a long but active owner stays below the query timeout, so
// the owner itself never times out, while the whole transaction outlasts two
// query timeouts of the waiter.
const OWNER_STATEMENT_SECONDS = (queryTimeoutMillis * 0.8) / 1000;
const OWNER_STATEMENTS = 3;

/** The order in which things happened, as labels. */
class Timeline {
  readonly events: string[] = [];

  record(event: string): void {
    this.events.push(event);
  }

  indexOf(event: string): number {
    const index = this.events.indexOf(event);
    expect(index, `${event} in ${this.events.join(', ')}`).toBeGreaterThan(-1);
    return index;
  }
}

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.message;
}

// Both pools use the default settings of AD-33; only the application name and
// the connection error callback are set.
describe('idempotency claims and the default pool timeouts', () => {
  let postgres: MigratedPostgres;
  let merchantId: string;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    merchantId = await insertTestMerchant(postgres.db);
  });

  afterAll(async () => {
    await postgres.stop();
  });

  async function withPools(
    timeline: Timeline,
    run: (owner: Database, waiter: Database) => Promise<void>,
  ): Promise<void> {
    const owner = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: OWNER_APPLICATION,
      onConnectionError: (error) =>
        timeline.record(`owner connection error ${describeFailure(error)}`),
    });
    const waiter = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: WAITER_APPLICATION,
      onConnectionError: (error) =>
        timeline.record(`waiter connection error ${describeFailure(error)}`),
    });
    try {
      await run(owner, waiter);
    } finally {
      await owner.destroy();
      await waiter.destroy();
    }
  }

  async function sessionsOf(applicationName: string): Promise<number> {
    const { rows } = await postgres.client.query<{ total: number }>(
      'select count(*)::int as total from pg_stat_activity where application_name = $1',
      [applicationName],
    );
    return rows[0]?.total ?? Number.NaN;
  }

  async function rowsOf(idempotencyKey: string) {
    const { rows } = await postgres.client.query<{
      operation_id: string;
      status: string;
    }>(
      'select operation_id, status from idempotency_records where idempotency_key = $1',
      [idempotencyKey],
    );
    return rows;
  }

  /**
   * Claims the key in the owner's transaction, runs `hold` inside it, and
   * records how the transaction ended. Resolves `claimed` once the claim
   * returned.
   */
  function ownerTransaction(
    owner: Database,
    timeline: Timeline,
    command: ReturnType<typeof claimCommand>,
    hold: (trx: DatabaseTransaction) => Promise<void>,
  ) {
    let claimed!: () => void;
    const hasClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const settled = owner
      .transaction()
      .execute(async (trx) => {
        const outcome = await idempotencyServices().claim.execute(trx, command);
        timeline.record(`owner claim ${outcome.outcome}`);
        claimed();
        await hold(trx);
      })
      .then(
        () => timeline.record('owner committed'),
        (error: unknown) =>
          timeline.record(`owner transaction failed ${describeFailure(error)}`),
      );
    return { hasClaimed, settled };
  }

  /** The same claim on the waiter's pool, recording each step. */
  function waiterTransaction(
    waiter: Database,
    timeline: Timeline,
    command: ReturnType<typeof claimCommand>,
  ) {
    return waiter
      .transaction()
      .execute(async (trx): Promise<ClaimIdempotencyKeyOutcome> => {
        try {
          const outcome = await idempotencyServices().claim.execute(trx, {
            ...command,
            operationId: randomUUID(),
          });
          timeline.record(`waiter claim ${outcome.outcome}`);
          return outcome;
        } catch (error) {
          timeline.record(`waiter claim failed ${describeFailure(error)}`);
          throw error;
        }
      })
      .then(
        (outcome) => timeline.record(`waiter committed ${outcome.outcome}`),
        (error: unknown) =>
          timeline.record(
            `waiter transaction failed ${describeFailure(error)}`,
          ),
      );
  }

  function sleep(trx: DatabaseTransaction, seconds: number) {
    return trx
      .selectNoFrom((eb) => eb.fn('pg_sleep', [eb.val(seconds)]).as('slept'))
      .execute();
  }

  it('releases the claim of an owner left idle past idle_in_transaction_session_timeout, after the waiting claim already failed', async () => {
    const timeline = new Timeline();
    const command = claimCommand(merchantId);

    await withPools(timeline, async (owner, waiter) => {
      let terminated!: () => void;
      const ownerTerminated = new Promise<void>((resolve) => {
        terminated = resolve;
      });
      const ownerRun = ownerTransaction(
        owner,
        timeline,
        command,
        async (trx) => {
          // Idle inside the transaction until PostgreSQL ends the session,
          // then try to continue.
          await ownerTerminated;
          await trx.selectNoFrom((eb) => eb.val(1).as('one')).execute();
        },
      );
      await ownerRun.hasClaimed;
      const waiterRun = waiterTransaction(waiter, timeline, command);
      await vi.waitFor(
        () => expect(timeline.events).toContain('owner connection error 25P03'),
        { timeout: idleInTransactionSessionTimeoutMillis + 5_000 },
      );
      terminated();
      await Promise.all([ownerRun.settled, waiterRun]);
    });

    // The waiting claim gave up at its client-side query timeout, before the
    // owner was ended, and it never returned an outcome.
    expect(
      timeline.indexOf('waiter claim failed Query read timeout'),
    ).toBeLessThan(timeline.indexOf('owner connection error 25P03'));
    expect(timeline.events).toContain(
      'waiter transaction failed Query read timeout',
    );
    expect(
      timeline.events.some((event) => event.startsWith('waiter claim C')),
    ).toBe(false);
    expect(
      timeline.events.find((event) =>
        event.startsWith('owner transaction failed'),
      ),
    ).toBeDefined();
    // Nothing of either transaction remains, and the key is free again.
    expect(await rowsOf(command.idempotencyKey)).toEqual([]);
    const fresh = await postgres.db
      .transaction()
      .execute((trx) => idempotencyServices().claim.execute(trx, command));
    expect(fresh.outcome).toBe('CLAIMED');
  }, 60_000);

  it('fails a claim that waits on a long active owner at the query timeout, discards its connection, and keeps the owner', async () => {
    const timeline = new Timeline();
    const command = claimCommand(merchantId);

    await withPools(timeline, async (owner, waiter) => {
      const ownerRun = ownerTransaction(
        owner,
        timeline,
        command,
        async (trx) => {
          for (
            let statement = 0;
            statement < OWNER_STATEMENTS;
            statement += 1
          ) {
            await sleep(trx, OWNER_STATEMENT_SECONDS);
          }
        },
      );
      await ownerRun.hasClaimed;
      await waiterTransaction(waiter, timeline, command);
      timeline.record('waiter settled');
      // The waiter's transaction ended on the client, but its backend is
      // still inside the insert, blocked on the owner.
      const waitingBackends = await sessionsOf(WAITER_APPLICATION);
      await ownerRun.settled;
      // Once the owner commits, the insert finishes, the server notices the
      // closed socket, and the backend goes away.
      await vi.waitFor(
        async () => expect(await sessionsOf(WAITER_APPLICATION)).toBe(0),
        { timeout: 10_000 },
      );

      expect(waitingBackends).toBe(1);
    });

    expect(timeline.events).toEqual([
      'owner claim CLAIMED',
      'waiter claim failed Query read timeout',
      // The rollback is queued behind the running insert and times out too.
      'waiter transaction failed Query read timeout',
      'waiter settled',
      'owner committed',
    ]);
    expect(await rowsOf(command.idempotencyKey)).toEqual([
      { operation_id: command.operationId, status: 'IN_PROGRESS' },
    ]);
  }, 60_000);

  it('leaves nothing of a timed-out claim whose insert succeeds on the server after the owner rolls back', async () => {
    const timeline = new Timeline();
    const command = claimCommand(merchantId);
    const rolledBack = new Error('owner rolls back');

    await withPools(timeline, async (owner, waiter) => {
      const ownerRun = ownerTransaction(
        owner,
        timeline,
        command,
        async (trx) => {
          for (
            let statement = 0;
            statement < OWNER_STATEMENTS;
            statement += 1
          ) {
            await sleep(trx, OWNER_STATEMENT_SECONDS);
          }
          throw rolledBack;
        },
      );
      await ownerRun.hasClaimed;
      await waiterTransaction(waiter, timeline, command);
      // The pool removed the connection whose rollback failed, so the next
      // transaction runs on another connection.
      const next = claimCommand(merchantId);
      await waiter
        .transaction()
        .execute((trx) => idempotencyServices().claim.execute(trx, next));
      await ownerRun.settled;
      await vi.waitFor(
        async () => expect(await sessionsOf(WAITER_APPLICATION)).toBe(1),
        { timeout: 10_000 },
      );

      expect(await rowsOf(next.idempotencyKey)).toHaveLength(1);
    });

    expect(timeline.events).toEqual([
      'owner claim CLAIMED',
      'waiter claim failed Query read timeout',
      'waiter transaction failed Query read timeout',
      'owner transaction failed owner rolls back',
    ]);
    // The discarded backend inserted the row once the owner rolled back, but
    // its transaction never committed.
    expect(await rowsOf(command.idempotencyKey)).toEqual([]);
    const fresh = await postgres.db
      .transaction()
      .execute((trx) => idempotencyServices().claim.execute(trx, command));
    expect(fresh.outcome).toBe('CLAIMED');
  }, 60_000);
});
