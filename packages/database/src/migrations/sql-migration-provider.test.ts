import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  InvalidMigrationError,
  MIGRATIONS_DIRECTORY,
  SqlMigrationProvider,
} from './sql-migration-provider.js';

function fixture(name: string): string {
  return fileURLToPath(
    new URL(`../../test/fixtures/${name}/`, import.meta.url),
  );
}

describe('SqlMigrationProvider', () => {
  it('names each migration after its file and gives it no down function', async () => {
    const migrations = await new SqlMigrationProvider(
      fixture('basic'),
    ).getMigrations();

    expect(Object.keys(migrations).sort()).toEqual([
      '20261101000000_create_alpha',
      '20261101000100_create_beta',
    ]);
    for (const migration of Object.values(migrations)) {
      expect(Object.keys(migration)).toEqual(['up']);
    }
  });

  it('ignores files that are not .sql files', async () => {
    const migrations = await new SqlMigrationProvider(
      fixture('ignored-files'),
    ).getMigrations();

    expect(Object.keys(migrations)).toEqual(['20261101000000_create_listed']);
  });

  it('rejects an .sql file whose name has no timestamp prefix', async () => {
    const failure = await new SqlMigrationProvider(fixture('invalid-name'))
      .getMigrations()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InvalidMigrationError);
    expect(failure).toMatchObject({ code: 'INVALID_MIGRATION_FILE' });
    expect((failure as Error).message).toContain('create_misnamed.sql');
  });

  it('rejects an empty file', async () => {
    const failure = await new SqlMigrationProvider(fixture('empty'))
      .getMigrations()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InvalidMigrationError);
  });

  it('rejects a directory that does not exist', async () => {
    await expect(
      new SqlMigrationProvider(fixture('does-not-exist')).getMigrations(),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finds the project migrations directory beside src and loads its first migration', async () => {
    const migrations = await new SqlMigrationProvider(
      MIGRATIONS_DIRECTORY,
    ).getMigrations();

    expect(
      MIGRATIONS_DIRECTORY.endsWith('/packages/database/migrations/'),
    ).toBe(true);
    expect(Object.keys(migrations)).toContain(
      '20261102233000_create_merchants_and_audit_events',
    );
  });
});
