import { configDefaults, defineConfig } from 'vitest/config';
import { defaultServerConditions } from 'vite';

// The persistent module cache is disabled because its key ignores tsconfig
// changes, so a stale transform could keep serving decorator metadata that the
// compiler options no longer enable. Files named *.integration.test.ts need
// Docker and run only through the `test:integration` script.
//
// Workspace packages are tested from their source through the
// `@merchantflow/source` export condition, which Vitest ignores unless it is
// listed here. The compiled API uses their `dist` output instead.
export default defineConfig({
  ssr: {
    resolve: {
      conditions: ['@merchantflow/source', ...defaultServerConditions],
    },
  },
  test: {
    environment: 'node',
    env: {
      // Request logs would flood the test output; tests that assert on logs
      // raise the level themselves.
      LOG_LEVEL: 'silent',
      // Nothing listens on port 1, so no unit or API test can reach a real
      // database by accident: the pool connects lazily and is refused at once.
      DATABASE_URL: 'postgresql://nobody:placeholder@127.0.0.1:1/placeholder',
    },
    fsModuleCache: false,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
