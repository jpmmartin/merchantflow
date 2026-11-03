import { startPostgres } from '@merchantflow/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashApiKeySecret,
  parseApiKey,
} from '../src/modules/auth/application/api-key-secret.js';
import { connectionFragments } from './support/connection-details.js';
import {
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const KEY_PATTERN = /mfk_[0-9a-f]{16}_[0-9a-f]{64}/g;

interface SeedRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunSeedCli = typeof import('../src/cli/run-seed-cli.js').runSeedCli;

/** Everything any run wrote to standard error, for searches across runs. */
const allStderr: string[] = [];

async function importCli(
  databaseUrl: string | undefined,
  environment: Record<string, string> = {},
): Promise<RunSeedCli> {
  // The configuration is validated when its module is loaded, so the module
  // cache is reset and the environment set before every import.
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', databaseUrl);
  for (const [name, value] of Object.entries(environment)) {
    vi.stubEnv(name, value);
  }
  return (await import('../src/cli/run-seed-cli.js')).runSeedCli;
}

async function runWith(runSeedCli: RunSeedCli): Promise<SeedRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runSeedCli({
    stdout: { write: (text) => stdout.push(text) },
    stderr: {
      write: (text) => {
        stderr.push(text);
        allStderr.push(text);
      },
    },
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function seed(
  databaseUrl: string | undefined,
  environment: Record<string, string> = {},
): Promise<SeedRun> {
  return runWith(await importCli(databaseUrl, environment));
}

async function withDatabase(
  test: (postgres: MigratedPostgres) => Promise<void>,
): Promise<void> {
  const postgres = await startMigratedPostgres();
  try {
    await test(postgres);
  } finally {
    await postgres.stop();
  }
}

/** The text of every row of the tables the seed could touch. */
async function tableText(postgres: MigratedPostgres): Promise<string> {
  const parts: string[] = [];
  for (const table of ['api_keys', 'audit_events', 'merchants']) {
    const { rows } = await postgres.client.query(
      `select * from ${table} order by 1`,
    );
    parts.push(JSON.stringify(rows));
  }
  return parts.join('\n');
}

function printedKeys(output: string): string[] {
  return output.match(KEY_PATTERN) ?? [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the db:seed command', () => {
  it('creates one platform administrator key, prints it once, and audits the issuance', async () => {
    await withDatabase(async (postgres) => {
      const run = await seed(postgres.connectionString);

      expect(run.code).toBe(0);
      const keys = printedKeys(run.stdout);
      expect(keys).toHaveLength(1);
      expect(run.stdout).toContain('shown only once');
      const parsed = parseApiKey(keys[0] ?? '');
      expect(parsed).toBeDefined();

      const stored = await postgres.client.query(
        'select id, lookup_id, secret_hash, merchant_id, role, revoked_at from api_keys',
      );
      expect(stored.rows).toHaveLength(1);
      const row = stored.rows[0] as {
        id: string;
        lookup_id: string;
        secret_hash: string;
        merchant_id: string | null;
        role: string;
        revoked_at: Date | null;
      };
      expect(row.role).toBe('PLATFORM_ADMIN');
      expect(row.merchant_id).toBeNull();
      expect(row.revoked_at).toBeNull();
      expect(row.lookup_id).toBe(parsed?.lookupId);
      expect(row.secret_hash).toBe(hashApiKeySecret(parsed?.secret ?? ''));

      const audit = await postgres.client.query(
        'select actor_type, actor_id, action, target_type, target_id, merchant_id, metadata from audit_events',
      );
      expect(audit.rows).toEqual([
        {
          actor_type: 'SYSTEM',
          actor_id: 'dev-seed',
          action: 'API_KEY_ISSUED',
          target_type: 'API_KEY',
          target_id: row.id,
          merchant_id: null,
          metadata: {
            lookup_id: row.lookup_id,
            role: 'PLATFORM_ADMIN',
            scope: 'PLATFORM',
          },
        },
      ]);
    });
  });

  it('prints the key nowhere but standard output: no log line, audit row, or table holds it', async () => {
    await withDatabase(async (postgres) => {
      const run = await seed(postgres.connectionString, { LOG_LEVEL: 'trace' });
      const [key] = printedKeys(run.stdout);
      const secret = parseApiKey(key ?? '')?.secret ?? '';
      expect(key).toBeDefined();
      expect(secret).not.toBe('');

      // The seed's own stream, and every stream any run of this file had.
      expect(run.stderr).not.toContain(secret);
      expect(allStderr.join('')).not.toContain(secret);
      expect(allStderr.join('')).not.toContain(key);
      // `nestjs-pino` keeps one logger per process, so the issuance line may
      // be in the stream of an earlier run; the search above covers them all.
      expect(allStderr.join('')).toContain('api key issued');
      expect(allStderr.join('')).not.toMatch(/Bearer/);

      const text = await tableText(postgres);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(key);
      for (const fragment of connectionFragments(postgres.connectionString)) {
        expect(run.stdout).not.toContain(fragment);
        expect(run.stderr).not.toContain(fragment);
      }
    });
  });

  it('does nothing and says so when an active platform key exists, however often it runs', async () => {
    await withDatabase(async (postgres) => {
      const first = await seed(postgres.connectionString);
      const [key] = printedKeys(first.stdout);
      const before = await tableText(postgres);
      const row = (await postgres.client.query('select id from api_keys'))
        .rows[0] as { id: string };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const again = await seed(postgres.connectionString);

        expect(again.code).toBe(0);
        expect(again.stdout).toContain('already exists');
        expect(again.stdout).toContain('Nothing was changed');
        expect(again.stdout).toContain(row.id);
        expect(printedKeys(again.stdout)).toEqual([]);
        expect(printedKeys(again.stderr)).toEqual([]);
        expect(again.stdout).not.toContain(parseApiKey(key ?? '')?.lookupId);
        expect(again.stderr).toBe('');
        expect(await tableText(postgres)).toBe(before);
      }
    });
  });

  it('creates a new key once the previous platform key is revoked', async () => {
    await withDatabase(async (postgres) => {
      const first = await seed(postgres.connectionString);
      await postgres.client.query(
        'update api_keys set revoked_at = now() where revoked_at is null',
      );

      const second = await seed(postgres.connectionString);

      expect(second.code).toBe(0);
      const [oldKey] = printedKeys(first.stdout);
      const [newKey] = printedKeys(second.stdout);
      expect(newKey).toBeDefined();
      expect(newKey).not.toBe(oldKey);
      const active = await postgres.client.query(
        'select count(*)::int as total from api_keys where revoked_at is null',
      );
      expect(active.rows).toEqual([{ total: 1 }]);
      const events = await postgres.client.query(
        'select count(*)::int as total from audit_events',
      );
      expect(events.rows).toEqual([{ total: 2 }]);
    });
  });

  it('creates exactly one key when two runs start together', async () => {
    await withDatabase(async (postgres) => {
      const runSeedCli = await importCli(postgres.connectionString);

      const runs = await Promise.all([
        runWith(runSeedCli),
        runWith(runSeedCli),
      ]);

      expect(runs.some((run) => run.code === 0)).toBe(true);
      const printed = runs.flatMap((run) => printedKeys(run.stdout));
      expect(printed).toHaveLength(1);
      for (const run of runs.filter((candidate) => candidate.code !== 0)) {
        expect(run.stderr).toContain('Another seed run is in progress');
      }
      const stored = await postgres.client.query(
        'select count(*)::int as total from api_keys',
      );
      const events = await postgres.client.query(
        'select count(*)::int as total from audit_events',
      );
      expect(stored.rows).toEqual([{ total: 1 }]);
      expect(events.rows).toEqual([{ total: 1 }]);
    });
  });

  it('refuses to run in production before connecting, and changes nothing', async () => {
    await withDatabase(async (postgres) => {
      const before = await tableText(postgres);
      const applied = await postgres.client.query(
        'select name from kysely_migration order by name',
      );

      const run = await seed(postgres.connectionString, {
        NODE_ENV: 'production',
      });

      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('NODE_ENV is "production"');
      expect(await tableText(postgres)).toBe(before);
      expect(
        (
          await postgres.client.query(
            'select name from kysely_migration order by name',
          )
        ).rows,
      ).toEqual(applied.rows);

      // A database nobody listens on proves that no connection is attempted:
      // the answer is the refusal, not a connection failure.
      const unreachable = await seed(
        'postgresql://user:secret@127.0.0.1:1/none',
        { NODE_ENV: 'production' },
      );
      expect(unreachable.code).toBe(1);
      expect(unreachable.stderr).toContain('NODE_ENV is "production"');
      expect(unreachable.stderr).not.toContain('could not be read');
    });
  });

  it('fails clearly on a database that is not migrated, and creates nothing in it', async () => {
    const postgres = await startPostgres();
    try {
      const run = await seed(postgres.getConnectionUri());

      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('The database is not migrated');
      expect(run.stderr).toContain('pnpm db:migrate');
      expect(printedKeys(run.stderr)).toEqual([]);

      const { Client } = await import('pg');
      const client = new Client({
        connectionString: postgres.getConnectionUri(),
      });
      await client.connect();
      try {
        const tables = await client.query(
          "select table_name from information_schema.tables where table_schema = 'public'",
        );
        expect(tables.rows).toEqual([]);
      } finally {
        await client.end();
      }
    } finally {
      await postgres.stop();
    }
  });

  it('fails clearly when the database is unreachable, without revealing the connection', async () => {
    const url =
      'postgresql://seed_user_9f2:seed-pass-9f2@127.0.0.1:1/seed_db_9f2';

    const run = await seed(url);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('The database could not be read (cause: ');
    for (const fragment of connectionFragments(url)) {
      expect(run.stderr).not.toContain(fragment);
    }
  });

  it('fails with the configuration error when DATABASE_URL is missing or invalid', async () => {
    const missing = await seed(undefined);
    const invalid = await seed('mysql://user:secret@host/db');

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('DATABASE_URL (invalid_type)');
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('DATABASE_URL (invalid_format)');
    expect(invalid.stderr).not.toContain('secret');
    expect(missing.stdout + invalid.stdout).toBe('');
  });
});
