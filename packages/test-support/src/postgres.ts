import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

// The image used by the `postgres` service in docker-compose.yml.
export const POSTGRES_IMAGE = 'postgres:17-alpine';

// Starts a disposable PostgreSQL container and resolves once it accepts
// connections. The caller stops it; Ryuk removes it if the process dies first.
export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).start();
}
