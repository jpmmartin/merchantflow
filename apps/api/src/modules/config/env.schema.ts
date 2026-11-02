import { z } from 'zod';

const TCP_PORT_MAX = 65535;

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
  HOST: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
});

export type Env = z.infer<typeof envSchema>;
