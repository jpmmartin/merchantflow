import { sql } from 'kysely';
import type { Database } from './schema.js';

/** Runs a trivial query, which rejects when PostgreSQL cannot answer it. */
export async function pingDatabase(database: Database): Promise<void> {
  await sql`select 1`.execute(database);
}
