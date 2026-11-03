import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from './create-database.js';

// Nothing listens on port 1, so a connection attempt is refused at once.
const UNREACHABLE_URL =
  'postgresql://nobody:placeholder@127.0.0.1:1/placeholder';

describe('createDatabase', () => {
  it('does not connect until the first query', async () => {
    const onConnectionError = vi.fn();
    const database = createDatabase({
      connectionString: UNREACHABLE_URL,
      onConnectionError,
    });

    await database.destroy();

    expect(onConnectionError).not.toHaveBeenCalled();
  });

  it('rejects a query when PostgreSQL is unreachable', async () => {
    const database = createDatabase({
      connectionString: UNREACHABLE_URL,
      onConnectionError: vi.fn(),
    });

    await expect(sql`select 1`.execute(database)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });

    await database.destroy();
  });
});
