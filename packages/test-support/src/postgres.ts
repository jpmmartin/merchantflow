import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

// The image used by the `postgres` service in docker-compose.yml.
export const POSTGRES_IMAGE = 'postgres:17-alpine';

/** Overrides for the container's default database, user, and password. */
export interface PostgresCredentials {
  readonly database?: string;
  readonly username?: string;
  readonly password?: string;
}

// Starts a disposable PostgreSQL container and resolves once it accepts
// connections. The caller stops it; Ryuk removes it if the process dies first.
// Distinct credentials let a test assert that none of them leaks into a log or
// a response, which the shared default (`test`) would make ambiguous.
export function startPostgres(
  credentials: PostgresCredentials = {},
): Promise<StartedPostgreSqlContainer> {
  let container = new PostgreSqlContainer(POSTGRES_IMAGE);
  if (credentials.database !== undefined) {
    container = container.withDatabase(credentials.database);
  }
  if (credentials.username !== undefined) {
    container = container.withUsername(credentials.username);
  }
  if (credentials.password !== undefined) {
    container = container.withPassword(credentials.password);
  }
  return container.start();
}
