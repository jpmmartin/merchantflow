import { Client } from 'pg';

/** `application_name` of the API's pool (`DatabaseModule`). */
const API_APPLICATION_NAME = 'merchantflow-api';

/** Statement prefixes of the create command, as Kysely writes them. */
export const CLAIM_STATEMENT = 'insert into "idempotency_records"';
export const MERCHANT_READ_STATEMENT =
  'select "id", "status", "default_currency" from "merchants"';

/** One server session of the API's pool, as `pg_stat_activity` shows it. */
export interface ApiSession {
  readonly pid: number;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly query: string;
  /** Sessions that hold a lock this one waits for (`pg_blocking_pids`). */
  readonly blockers: readonly number[];
}

/** Every session the API's pool has open on the server right now. */
export async function apiSessions(sql: Client): Promise<ApiSession[]> {
  const result = await sql.query<{
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    query: string;
    blockers: number[];
  }>(
    `select pid, state, wait_event_type, wait_event, query,
            pg_blocking_pids(pid) as blockers
     from pg_stat_activity
     where application_name = $1 and backend_type = 'client backend'
     order by pid`,
    [API_APPLICATION_NAME],
  );
  return result.rows.map((row) => ({
    pid: row.pid,
    state: row.state,
    waitEventType: row.wait_event_type,
    waitEvent: row.wait_event,
    query: row.query,
    blockers: row.blockers,
  }));
}

/** True when the session waits for a lock in a statement with the prefix. */
export function waitsIn(session: ApiSession, statement: string): boolean {
  return (
    session.waitEventType === 'Lock' && session.query.startsWith(statement)
  );
}

/**
 * A connection of the test that holds the row lock a merchant status change
 * takes (`FOR NO KEY UPDATE`), which conflicts with the `FOR SHARE` read of the
 * create command. Every creation for that merchant stops at its merchant read
 * until the gate is released.
 */
export class MerchantRowGate {
  private constructor(
    private readonly client: Client,
    readonly pid: number,
  ) {}

  static async open(connectionString: string): Promise<MerchantRowGate> {
    const client = new Client({ connectionString });
    await client.connect();
    const result = await client.query<{ pid: number }>(
      'select pg_backend_pid() as pid',
    );
    const pid = result.rows[0]?.pid;
    if (pid === undefined) throw new Error('Expected the backend pid');
    return new MerchantRowGate(client, pid);
  }

  async hold(merchantId: string): Promise<void> {
    await this.client.query('begin');
    await this.client.query(
      'select 1 from merchants where id = $1 for no key update',
      [merchantId],
    );
  }

  async release(): Promise<void> {
    await this.client.query('commit');
  }

  /** Ends a hold that a failed test left open. */
  async reset(): Promise<void> {
    await this.client.query('rollback');
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
