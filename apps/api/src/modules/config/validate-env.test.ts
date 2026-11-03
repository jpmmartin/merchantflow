import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InvalidConfigurationError,
  parseEnv,
  validateEnv,
} from './validate-env.js';

const SENSITIVE_VALUE = 'sup3r-s3cret-value';

function captureError(run: () => unknown): InvalidConfigurationError {
  try {
    run();
  } catch (error) {
    if (error instanceof InvalidConfigurationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the validation to fail');
}

describe('validateEnv', () => {
  it('applies development defaults to an empty environment', () => {
    expect(validateEnv({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
    });
  });

  it('parses valid values into typed output', () => {
    expect(
      validateEnv({ NODE_ENV: 'production', PORT: '8080', HOST: '0.0.0.0' }),
    ).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
    });
  });

  it('ignores variables it does not define', () => {
    expect(validateEnv({ PATH: '/usr/bin', HOME: '/home/node' })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
    });
  });

  it.each(['abc', '0', '65536', '-1', '80.5', '1e3', '0x10', ''])(
    'rejects PORT=%j without echoing it',
    (port) => {
      const error = captureError(() => validateEnv({ PORT: port }));
      expect(error.variables).toEqual(['PORT']);
      expect(error.message).toContain('PORT');
    },
  );

  it.each(['localhost', '999.1.1.1', '0.0.0', ''])(
    'rejects HOST=%j without echoing it',
    (host) => {
      const error = captureError(() => validateEnv({ HOST: host }));
      expect(error.variables).toEqual(['HOST']);
    },
  );

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])(
    'accepts LOG_LEVEL=%s',
    (level) => {
      expect(validateEnv({ LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    },
  );

  it.each(['verbose', 'INFO', '', '10'])(
    'rejects LOG_LEVEL=%j without echoing it',
    (level) => {
      const error = captureError(() => validateEnv({ LOG_LEVEL: level }));
      expect(error.variables).toEqual(['LOG_LEVEL']);
      expect(error.message).not.toContain(`(${level})`);
    },
  );

  it('accepts an IPv6 HOST', () => {
    expect(validateEnv({ HOST: '::1' }).HOST).toBe('::1');
  });

  it('names every invalid variable and omits their values', () => {
    const error = captureError(() =>
      validateEnv({
        NODE_ENV: SENSITIVE_VALUE,
        PORT: `${SENSITIVE_VALUE}-port`,
      }),
    );
    expect(error.variables).toEqual(['NODE_ENV', 'PORT']);
    expect(error.message).toContain('NODE_ENV');
    expect(error.message).toContain('PORT');
    expect(error.message).not.toContain(SENSITIVE_VALUE);
  });
});

describe('parseEnv', () => {
  const schema = z.object({
    API_SECRET: z.string().min(32),
    TOKEN: z.string(),
  });

  it('reports a missing variable by name', () => {
    const error = captureError(() =>
      parseEnv(schema, { API_SECRET: 'x'.repeat(32) }),
    );
    expect(error.variables).toEqual(['TOKEN']);
    expect(error.message).toBe(
      'Invalid environment configuration: TOKEN (invalid_type)',
    );
  });

  it('does not leak a rejected secret even when the rule is not a type check', () => {
    const error = captureError(() =>
      parseEnv(schema, { API_SECRET: SENSITIVE_VALUE, TOKEN: 't' }),
    );
    expect(error.message).toBe(
      'Invalid environment configuration: API_SECRET (too_small)',
    );
    expect(error.message).not.toContain(SENSITIVE_VALUE);
  });
});
