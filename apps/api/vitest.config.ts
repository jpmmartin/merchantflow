import { defineConfig } from 'vitest/config';

// The persistent module cache is disabled because its key ignores tsconfig
// changes, so a stale transform could keep serving decorator metadata that the
// compiler options no longer enable.
export default defineConfig({
  test: {
    environment: 'node',
    fsModuleCache: false,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
