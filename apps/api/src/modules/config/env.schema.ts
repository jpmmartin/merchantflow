import { z } from 'zod';
import { isMasterKeyEncoding } from './master-key.js';

const TCP_PORT_MAX = 65535;

/**
 * One browser origin: `http` or `https`, a host, and an optional port, with no
 * path, no trailing slash, and no wildcard, because the CORS check compares
 * origins as exact strings.
 */
const ORIGIN_PATTERN =
  /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$|^https?:\/\/\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * Environment variables the API reads. Every entry is either required or has a
 * default that is safe for local development; secrets must never get a default.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(TCP_PORT_MAX))
    .default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  HOST: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
  // Carries the database password, so it is required and has no default.
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Comma-separated browser origins allowed to call the API. Without it, the
  // development and test default of `cors-origins.ts` applies, and production
  // allows no cross-origin caller.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .transform((value) => value.split(',').map((origin) => origin.trim()))
    .pipe(z.array(z.string().regex(ORIGIN_PATTERN)).min(1))
    .optional(),
  // Email of the platform administrator user created by `pnpm db:seed`.
  // Without it the seed uses its documented default.
  SEED_ADMIN_EMAIL: z.email().optional(),
  // Public base URL of the API (scheme, host, and optional port, no path), the
  // address providers deliver webhooks to, such as the ngrok domain in local
  // work. Without it, the automatic webhook configuration is refused with 503
  // PUBLIC_BASE_URL_NOT_CONFIGURED. An empty value counts as unset.
  PUBLIC_API_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(ORIGIN_PATTERN).optional(),
  ),
  // Master key that encrypts the secret keys of processor accounts: 32 random
  // bytes in standard base64 (44 characters). It is a secret, so it has no
  // default. Outside production it may be unset, and connecting an account
  // then answers 503; production refuses to start without it. An empty value
  // counts as unset, because Compose passes an unset variable as empty.
  CREDENTIALS_MASTER_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().refine(isMasterKeyEncoding).optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;
