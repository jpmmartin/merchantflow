import { defineConfig } from 'vitest/config';
import { defaultServerConditions } from 'vite';

// Starting a container can include pulling the Ryuk image, so the hook timeout
// is far above Vitest's default. The tests set DATABASE_URL themselves, from
// the container they start. Workspace packages are loaded from their source
// through the `@merchantflow/source` export condition.
export default defineConfig({
  ssr: {
    resolve: {
      conditions: ['@merchantflow/source', ...defaultServerConditions],
    },
  },
  test: {
    environment: 'node',
    fsModuleCache: false,
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
