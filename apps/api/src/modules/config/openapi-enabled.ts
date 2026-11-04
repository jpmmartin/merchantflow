import type { Env } from './env.schema.js';

/**
 * Whether the API serves its OpenAPI document and interactive documentation:
 * `OPENAPI_ENABLED` when it is set, otherwise on outside production and off in
 * production. This is the one place where that default is decided.
 */
export function isOpenApiEnabled(
  env: Pick<Env, 'NODE_ENV' | 'OPENAPI_ENABLED'>,
): boolean {
  return env.OPENAPI_ENABLED ?? env.NODE_ENV !== 'production';
}
