import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@merchantflow/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ClaimIdempotencyKeyCommand,
  ClaimIdempotencyKeyOutcome,
} from '../src/modules/idempotency/application/claim-idempotency-key.service.js';
import {
  claimCommand,
  idempotencyServices,
  insertTestMerchant,
} from './support/idempotency.js';
import {
  expectDatabaseError,
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const RACERS = 50;
const RACE_APPLICATION = 'idempotency-race';

type IsolationLevel = 'repeatable read' | 'serializable';

/** A promise and the function that resolves it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * One claim in its own transaction on its own connection. It records its
 * outcome as soon as the claim returns, waits for the promise that `release`
 * returns at that moment, and then commits or, when `rollbackOwner` says so for
 * an owner, rolls back.
 */
async function claimAndHold(
  db: Database,
  command: ClaimIdempotencyKeyCommand,
  settled: ClaimIdempotencyKeyOutcome[],
  release: () => Promise<void>,
  options: {
    readonly isolation?: IsolationLevel;
    readonly rollbackOwner?: () => boolean;
  } = {},
): Promise<ClaimIdempotencyKeyOutcome> {
  const builder = db.startTransaction();
  const trx = await (
    options.isolation === undefined
      ? builder
      : builder.setIsolationLevel(options.isolation)
  ).execute();
  try {
    const outcome = await idempotencyServices().claim.execute(trx, command);
    settled.push(outcome);
    await release();
    if (outcome.outcome === 'CLAIMED' && options.rollbackOwner?.() === true) {
      await trx.rollback().execute();
    } else {
      await trx.commit().execute();
    }
    return outcome;
  } catch (error) {
    await trx.rollback().execute();
    throw error;
  }
}

describe('idempotency claims under concurrency', () => {
  let postgres: MigratedPostgres;
  let race: Database;
  let merchantId: string;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    // One connection per concurrent claim, so that every claim holds its own
    // transaction at the same time. The claims wait on an owner that the test
    // holds open on purpose, so the client-side query timeout is raised above
    // that wait; how the default timeouts interact with a waiting claim is
    // measured in idempotency-timeouts.integration.test.ts.
    race = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: RACE_APPLICATION,
      maxConnections: RACERS,
      queryTimeoutMillis: 60_000,
      onConnectionError: () => undefined,
    });
    merchantId = await insertTestMerchant(postgres.db);
  });

  afterAll(async () => {
    await race.destroy();
    await postgres.stop();
  });

  /**
   * The race connections blocked on another transaction, with the backend that
   * blocks each of them.
   */
  async function blockedClaims(): Promise<
    { pid: number; blockers: number[] }[]
  > {
    const { rows } = await postgres.client.query<{
      pid: number;
      blockers: number[];
    }>(
      `select pid, pg_blocking_pids(pid) as blockers
       from pg_stat_activity
       where application_name = $1
         and wait_event_type = 'Lock'
         and wait_event = 'transactionid'
         and query like 'insert into "idempotency_records"%'`,
      [RACE_APPLICATION],
    );
    return rows;
  }

  /** The race connection that is idle inside an open transaction, if any. */
  async function idleOwners(): Promise<number[]> {
    const { rows } = await postgres.client.query<{ pid: number }>(
      `select pid from pg_stat_activity
       where application_name = $1 and state = 'idle in transaction'`,
      [RACE_APPLICATION],
    );
    return rows.map((row) => row.pid);
  }

  /** Waits until `waiting` claims are blocked, all by one idle owner, and returns it. */
  async function expectWaitingOn(waiting: number): Promise<number> {
    return vi.waitFor(
      async () => {
        const blocked = await blockedClaims();
        const owners = await idleOwners();
        expect(blocked).toHaveLength(waiting);
        expect(owners).toHaveLength(1);
        for (const claim of blocked) {
          expect(claim.blockers).toEqual(owners);
        }
        return owners[0]!;
      },
      { timeout: 30_000, interval: 20 },
    );
  }

  async function rowsOf(idempotencyKey: string) {
    const { rows } = await postgres.client.query<{ operation_id: string }>(
      'select * from idempotency_records where idempotency_key = $1',
      [idempotencyKey],
    );
    return rows;
  }

  function tally(outcomes: readonly ClaimIdempotencyKeyOutcome[]) {
    const counts: Record<string, number> = {};
    for (const { outcome } of outcomes) {
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
  }

  it(`gives exactly one owner to ${RACERS} overlapping claims of one key`, async () => {
    const command = claimCommand(merchantId);
    const settled: ClaimIdempotencyKeyOutcome[] = [];
    const release = gate();

    const claims = Array.from({ length: RACERS }, () =>
      claimAndHold(
        race,
        { ...command, operationId: randomUUID() },
        settled,
        () => release.opened,
      ),
    );
    // All claims have started: one returned as owner and is holding its
    // transaction open, and the other 49 are inside their insert, blocked on
    // the owner's uncommitted row.
    await expectWaitingOn(RACERS - 1);
    expect(tally(settled)).toEqual({ CLAIMED: 1 });
    release.open();
    const outcomes = await Promise.all(claims);

    expect(tally(outcomes)).toEqual({ CLAIMED: 1, IN_PROGRESS: RACERS - 1 });
    const owner = outcomes.find((outcome) => outcome.outcome === 'CLAIMED');
    const rows = await rowsOf(command.idempotencyKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operation_id).toBe(
      owner?.outcome === 'CLAIMED' ? owner.record.operationId : undefined,
    );
    // Every non-owner learned the owner's operation ID, not its own.
    for (const outcome of outcomes) {
      if (outcome.outcome === 'IN_PROGRESS') {
        expect(outcome.operationId).toBe(rows[0]?.operation_id);
      }
    }
  });

  it('makes exactly one waiting claim the owner when the first owner rolls back', async () => {
    const command = claimCommand(merchantId);
    const settled: ClaimIdempotencyKeyOutcome[] = [];
    const firstRelease = gate();
    const laterRelease = gate();
    let owners = 0;

    // The first owner waits on the first gate and rolls back; every later
    // claim waits on the second gate and commits.
    const claims = Array.from({ length: RACERS }, () =>
      claimAndHold(
        race,
        { ...command, operationId: randomUUID() },
        settled,
        () =>
          settled.length === 1 ? firstRelease.opened : laterRelease.opened,
        { rollbackOwner: () => ++owners === 1 },
      ),
    );
    const firstOwner = await expectWaitingOn(RACERS - 1);
    firstRelease.open();
    // A waiting claim inserted its row once the first owner rolled back, and
    // the remaining 48 now wait on that new owner.
    const secondOwner = await expectWaitingOn(RACERS - 2);
    expect(secondOwner).not.toBe(firstOwner);
    expect(tally(settled)).toEqual({ CLAIMED: 2 });
    laterRelease.open();
    const outcomes = await Promise.all(claims);

    expect(tally(outcomes)).toEqual({ CLAIMED: 2, IN_PROGRESS: RACERS - 2 });
    const rows = await rowsOf(command.idempotencyKey);
    expect(rows).toHaveLength(1);
    const committedOwner = outcomes.filter(
      (outcome) => outcome.outcome === 'CLAIMED',
    )[1];
    expect(rows[0]?.operation_id).toBe(
      committedOwner?.outcome === 'CLAIMED'
        ? committedOwner.record.operationId
        : undefined,
    );
  });

  it('makes a single waiting claim the owner when the owner rolls back', async () => {
    const command = claimCommand(merchantId);
    const settled: ClaimIdempotencyKeyOutcome[] = [];
    const release = gate();

    const owner = claimAndHold(race, command, settled, () => release.opened, {
      rollbackOwner: () => true,
    });
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    const waiter = race.transaction().execute((trx) =>
      idempotencyServices().claim.execute(trx, {
        ...command,
        operationId: randomUUID(),
      }),
    );
    await expectWaitingOn(1);
    release.open();

    expect((await owner).outcome).toBe('CLAIMED');
    const outcome = await waiter;
    expect(outcome.outcome).toBe('CLAIMED');
    const rows = await rowsOf(command.idempotencyKey);
    expect(rows.map((row) => row.operation_id)).toEqual([
      outcome.outcome === 'CLAIMED' ? outcome.record.operationId : undefined,
    ]);
  });

  it('answers REPLAY to claims that waited on an owner that completed in the same transaction', async () => {
    const command = claimCommand(merchantId);
    const response = { statusCode: 201, body: { id: 'pi_1' } };
    const release = gate();
    const services = idempotencyServices();

    const owner = race.transaction().execute(async (trx) => {
      const outcome = await services.claim.execute(trx, command);
      if (outcome.outcome !== 'CLAIMED') throw new Error(outcome.outcome);
      await services.complete.execute(trx, {
        record: outcome.record,
        response,
      });
      await release.opened;
    });
    await vi.waitFor(async () => expect(await idleOwners()).toHaveLength(1));
    const waiters = Array.from({ length: 5 }, () =>
      race.transaction().execute((trx) => services.claim.execute(trx, command)),
    );
    await expectWaitingOn(5);
    release.open();
    await owner;

    for (const outcome of await Promise.all(waiters)) {
      expect(outcome).toMatchObject({ outcome: 'REPLAY', response });
    }
  });

  it('answers KEY_REUSED to a waiting claim with a different request once the owner commits', async () => {
    const command = claimCommand(merchantId);
    const settled: ClaimIdempotencyKeyOutcome[] = [];
    const release = gate();

    const owner = claimAndHold(race, command, settled, () => release.opened);
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    const waiter = race.transaction().execute((trx) =>
      idempotencyServices().claim.execute(trx, {
        ...command,
        request: { different: true },
      }),
    );
    await expectWaitingOn(1);
    release.open();
    await owner;

    expect(await waiter).toEqual({ outcome: 'KEY_REUSED' });
  });

  it('keeps concurrent claims of different keys independent', async () => {
    const commands = Array.from({ length: RACERS }, () =>
      claimCommand(merchantId),
    );

    const outcomes = await Promise.all(
      commands.map((command) =>
        race
          .transaction()
          .execute((trx) => idempotencyServices().claim.execute(trx, command)),
      ),
    );

    expect(tally(outcomes)).toEqual({ CLAIMED: RACERS });
  });

  describe.each<IsolationLevel>(['repeatable read', 'serializable'])(
    'under %s',
    (isolation) => {
      it('fails a claim that waited on an owner that then committed, with serialization_failure', async () => {
        const command = claimCommand(merchantId);
        const settled: ClaimIdempotencyKeyOutcome[] = [];
        const release = gate();

        const owner = claimAndHold(
          race,
          command,
          settled,
          () => release.opened,
        );
        await vi.waitFor(() => expect(settled).toHaveLength(1));
        const waiter = claimAndHold(
          race,
          command,
          settled,
          () => Promise.resolve(),
          {
            isolation,
          },
        );
        await expectWaitingOn(1);
        release.open();
        await owner;

        await expectDatabaseError(waiter, { code: '40001' });
        expect(await rowsOf(command.idempotencyKey)).toHaveLength(1);
      });

      it('answers normally when the existing row was committed before the transaction started', async () => {
        const command = claimCommand(merchantId);
        await postgres.db
          .transaction()
          .execute((trx) => idempotencyServices().claim.execute(trx, command));

        const outcome = await race
          .transaction()
          .setIsolationLevel(isolation)
          .execute((trx) => idempotencyServices().claim.execute(trx, command));

        expect(outcome.outcome).toBe('IN_PROGRESS');
      });
    },
  );
});
