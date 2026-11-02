import { configDefaults, defineConfig } from 'vitest/config';

// The persistent module cache is disabled because its key ignores tsconfig
// changes, so a stale transform could keep serving decorator metadata that the
// compiler options no longer enable. Files named *.integration.test.ts need
// Docker and run only through the `test:integration` script.
export default defineConfig({
  test: {
    environment: 'node',
    fsModuleCache: false,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
