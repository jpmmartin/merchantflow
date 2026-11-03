import { fileURLToPath } from 'node:url';
import { startPostgres } from '@merchantflow/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionFragments } from './support/connection-details.js';
import { CREDENTIALS } from './support/database-fixtures.js';

function fixture(name: string): string {
  return fileURLToPath(
    new URL(`./fixtures/migrations/${name}/`, import.meta.url),
  );
}

/**
 * Runs the CLI logic against a database URL and captures what it prints. The
 * configuration is validated when its module is imported, so the module cache
 * is reset and the environment set before every run.
 */
async function run(databaseUrl: string | undefined, directory?: string) {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', databaseUrl);
  const { runMigrateCli: runCli } =
    await import('../src/cli/run-migrate-cli.js');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli({
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
    ...(directory === undefined ? {} : { directory }),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the db:migrate command', () => {
  it('applies the pending migrations, prints the status, and applies nothing on the next run', async () => {
    const postgres = await startPostgres(CREDENTIALS);
    try {
      const url = postgres.getConnectionUri();

      const first = await run(url, fixture('valid'));
      const second = await run(url, fixture('valid'));

      expect(first.code).toBe(0);
      expect(first.stderr).toBe('');
      expect(first.stdout).toContain(
        'Applied in this run: 20261101000000_create_probe',
      );
      expect(first.stdout).toMatch(
        /applied {2}20261101000000_create_probe {2}\d{4}-/,
      );
      expect(first.stdout).toContain('Nothing is pending.');
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Applied in this run: none');
      expect(second.stdout).toContain('Nothing is pending.');
    } finally {
      await postgres.stop();
    }
  });

  it('succeeds and reports nothing pending when there are no migrations', async () => {
    const postgres = await startPostgres(CREDENTIALS);
    try {
      const result = await run(postgres.getConnectionUri(), fixture('none'));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        'Applied in this run: none\nMigration status:\nNothing is pending.\n',
      );
    } finally {
      await postgres.stop();
    }
  });

  it('exits non-zero and names the failed migration and its cause, without connection details', async () => {
    const postgres = await startPostgres(CREDENTIALS);
    try {
      const url = postgres.getConnectionUri();

      const result = await run(url, fixture('failing'));

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Migration "20261101000000_create_failing" failed (cause: 42P01)',
      );
      expect(result.stderr).not.toContain('table_that_does_not_exist');
      for (const fragment of [
        ...connectionFragments(url),
        ...Object.values(CREDENTIALS),
      ]) {
        expect(result.stderr).not.toContain(fragment);
      }
    } finally {
      await postgres.stop();
    }
  });

  it('exits non-zero for an invalid DATABASE_URL without printing it', async () => {
    const secret = 'cli-secret-4c1e';
    const url = `mysql://cli_user:${secret}@db.cli.internal:3306/cli_db`;

    const result = await run(url);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Invalid environment configuration: DATABASE_URL (invalid_format)\n',
    );
    for (const fragment of [...connectionFragments(url), secret]) {
      expect(result.stderr).not.toContain(fragment);
    }
  });

  it('exits non-zero when DATABASE_URL is missing', async () => {
    const result = await run(undefined);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL');
  });

  it('exits non-zero without connection details when PostgreSQL is stopped', async () => {
    const postgres = await startPostgres(CREDENTIALS);
    const url = postgres.getConnectionUri();
    await postgres.stop();

    const result = await run(url, fixture('valid'));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Migration run failed \(cause: [A-Z0-9_]+\)/);
    for (const fragment of [
      ...connectionFragments(url),
      ...Object.values(CREDENTIALS),
    ]) {
      expect(result.stderr).not.toContain(fragment);
    }
  });
});
