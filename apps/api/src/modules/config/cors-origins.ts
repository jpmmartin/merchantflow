import type { Env } from './env.schema.js';

/**
 * Origins of the Vite development server of `apps/web`, as a browser on the
 * host reaches it through the port Compose publishes.
 */
export const DEVELOPMENT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

/**
 * The browser origins allowed to call the API: `CORS_ALLOWED_ORIGINS` when it
 * is set, otherwise the Vite development origins outside production and no
 * origin at all in production. The list never holds a wildcard.
 */
export function resolveCorsOrigins(
  env: Pick<Env, 'NODE_ENV' | 'CORS_ALLOWED_ORIGINS'>,
): readonly string[] {
  if (env.CORS_ALLOWED_ORIGINS !== undefined) return env.CORS_ALLOWED_ORIGINS;
  return env.NODE_ENV === 'production' ? [] : DEVELOPMENT_CORS_ORIGINS;
}
