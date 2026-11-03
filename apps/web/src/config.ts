/** Where the API is reached when `VITE_API_BASE_URL` is not set. */
const DEFAULT_API_BASE_URL = 'http://localhost:3000/api/v1';

/**
 * Base URL of the versioned API, from Vite's environment (`VITE_API_BASE_URL`
 * in the repository-root `.env`), without a trailing slash.
 */
export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL
).replace(/\/+$/, '');
