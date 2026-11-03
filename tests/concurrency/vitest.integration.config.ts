import { defineConfig } from 'vitest/config';
import { defaultServerConditions } from 'vite';

// Starting a container can include pulling the Ryuk image, so the hook timeout
// is far above Vitest's default. The suite sets DATABASE_URL itself, from the
// container it starts. Workspace packages, the API included, are loaded from
// their source through the `@merchantflow/source` export condition; each API
// file is transformed with the closest tsconfig.json, which is the API's own and
// enables decorator metadata.
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
