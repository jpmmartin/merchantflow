import type { z } from 'zod';
import { envSchema, type Env } from './env.schema.js';

/** Raised when the environment does not satisfy the schema. */
export class InvalidConfigurationError extends Error {
  constructor(
    readonly variables: readonly string[],
    details: readonly string[],
  ) {
    super(`Invalid environment configuration: ${details.join(', ')}`);
    this.name = 'InvalidConfigurationError';
  }
}

/**
 * Parses an environment against a schema. The error names each invalid
 * variable with the Zod issue code and never includes the received value,
 * because some messages (and `reportInput`) can echo it.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  input: Record<string, unknown>,
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const byVariable = new Map<string, Set<string>>();
  for (const issue of result.error.issues) {
    const name =
      issue.path.length > 0
        ? issue.path.map(String).join('.')
        : '<environment>';
    byVariable.set(name, (byVariable.get(name) ?? new Set()).add(issue.code));
  }
  const details = [...byVariable].map(
    ([name, codes]) => `${name} (${[...codes].join(', ')})`,
  );
  throw new InvalidConfigurationError([...byVariable.keys()], details);
}

/** Validation function handed to `ConfigModule`. */
export function validateEnv(input: Record<string, unknown>): Env {
  return parseEnv(envSchema, input);
}
