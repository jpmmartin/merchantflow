import type { Kysely } from 'kysely';

/**
 * Table types of the database, keyed by table name. It is empty until the first
 * migration creates a table; each increment then adds the row types of the
 * tables it owns.
 */
export type DatabaseSchema = Record<never, never>;

/** The Kysely instance that every query and transaction goes through. */
export type Database = Kysely<DatabaseSchema>;
