import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

/** Port of the development server, published by Compose on the host. */
const DEV_SERVER_PORT = 5173;

export default defineConfig({
  plugins: [react()],
  // Workspace packages, such as @merchantflow/domain, are bundled from their
  // TypeScript source through the `@merchantflow/source` export condition, so
  // the frontend needs no prior build of them.
  resolve: {
    conditions: ['@merchantflow/source', ...defaultClientConditions],
  },
  // `.env` files are read from the repository root, like the API's. Only
  // variables prefixed with `VITE_` reach the browser bundle.
  envDir: '../..',
  server: {
    // Compose sets HOST=0.0.0.0 in the `dev` container, because a server bound
    // to the container's loopback is unreachable through a published port.
    // Elsewhere the server stays private to the machine.
    // eslint-disable-next-line no-restricted-properties -- build tool configuration, outside the API's ConfigService
    host: process.env['HOST'] ?? '127.0.0.1',
    port: DEV_SERVER_PORT,
    strictPort: true,
  },
  preview: {
    port: DEV_SERVER_PORT,
    strictPort: true,
  },
});
