import { configDefaults, defineConfig } from 'vitest/config';

// Files named *.integration.test.ts need Docker and run only through the
// `test:integration` script.
export default defineConfig({
  test: {
    environment: 'node',
    fsModuleCache: false,
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
