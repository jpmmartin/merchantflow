import { defineConfig } from 'vitest/config';

// Starting a container can include pulling the Ryuk image, so the hook timeout
// is far above Vitest's default.
export default defineConfig({
  test: {
    environment: 'node',
    fsModuleCache: false,
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
