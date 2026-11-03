import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

/**
 * Directory of the project's migrations, at the root of this package. It sits
 * beside `src/` and `dist/`, which have the same depth, so the same relative
 * path resolves from the TypeScript source and from the compiled output without
 * a copy step (`tsc` does not copy `.sql` files).
 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

// A 14-digit UTC timestamp (YYYYMMDDHHMMSS), then a snake_case description. The
// fixed width makes alphabetical order the same as chronological order, which
// is the order the migrator enforces.
const MIGRATION_FILE = /^(\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** A migration file the provider refuses to load. The message is safe to print. */
export class InvalidMigrationError extends Error {
  readonly code = 'INVALID_MIGRATION_FILE';

  constructor(fileName: string, reason: string) {
    super(`Invalid migration file "${fileName}": ${reason}`);
    this.name = 'InvalidMigrationError';
  }
}

/**
 * Loads forward-only migrations from plain `.sql` files. The migration name is
 * the file name without its extension. Files with another extension are
 * ignored, and an `.sql` file whose name does not follow the pattern is an
 * error, so a misnamed file can never be skipped silently.
 *
 * The provider supplies no `down` function, so nothing can be rolled back
 * through it.
 */
export class SqlMigrationProvider implements MigrationProvider {
  constructor(private readonly directory: string = MIGRATIONS_DIRECTORY) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const migrations: Record<string, Migration> = {};
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.sql')) {
        continue;
      }
      const match = MIGRATION_FILE.exec(entry.name);
      const name = match?.[1];
      if (name === undefined) {
        throw new InvalidMigrationError(
          entry.name,
          'expected <14-digit UTC timestamp>_<snake_case_description>.sql',
        );
      }
      const content = await readFile(join(this.directory, entry.name), 'utf8');
      if (content.trim() === '') {
        throw new InvalidMigrationError(entry.name, 'the file is empty');
      }
      migrations[name] = {
        // No bound parameters, so `pg` uses the simple query protocol, which
        // accepts several statements in one string.
        up: async (database) => {
          await sql.raw(content).execute(database);
        },
      };
    }
    return migrations;
  }
}
