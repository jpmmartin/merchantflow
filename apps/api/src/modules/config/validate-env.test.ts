import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InvalidConfigurationError,
  parseEnv,
  validateEnv,
} from './validate-env.js';

const SENSITIVE_VALUE = 'sup3r-s3cret-value';
const DB_PASSWORD = 'distinctive-db-password-4e7b';
const DATABASE_URL = `postgresql://app_user:${DB_PASSWORD}@db.internal:5432/payments`;
const BASE_ENV = { DATABASE_URL };

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
  it('applies development defaults to an environment with only the required variables', () => {
    expect(validateEnv(BASE_ENV)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      DATABASE_URL,
    });
  });

  it('parses valid values into typed output', () => {
    expect(
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
      }),
    ).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      DATABASE_URL,
    });
  });

  it('ignores variables it does not define', () => {
    expect(
      validateEnv({ ...BASE_ENV, PATH: '/usr/bin', HOME: '/home/node' }),
    ).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      DATABASE_URL,
    });
  });

  it.each(['abc', '0', '65536', '-1', '80.5', '1e3', '0x10', ''])(
    'rejects PORT=%j without echoing it',
    (port) => {
      const error = captureError(() =>
        validateEnv({ ...BASE_ENV, PORT: port }),
      );
      expect(error.variables).toEqual(['PORT']);
      expect(error.message).toContain('PORT');
    },
  );

  it.each(['localhost', '999.1.1.1', '0.0.0', ''])(
    'rejects HOST=%j without echoing it',
    (host) => {
      const error = captureError(() =>
        validateEnv({ ...BASE_ENV, HOST: host }),
      );
      expect(error.variables).toEqual(['HOST']);
    },
  );

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])(
    'accepts LOG_LEVEL=%s',
    (level) => {
      expect(validateEnv({ ...BASE_ENV, LOG_LEVEL: level }).LOG_LEVEL).toBe(
        level,
      );
    },
  );

  it.each(['verbose', 'INFO', '', '10'])(
    'rejects LOG_LEVEL=%j without echoing it',
    (level) => {
      const error = captureError(() =>
        validateEnv({ ...BASE_ENV, LOG_LEVEL: level }),
      );
      expect(error.variables).toEqual(['LOG_LEVEL']);
      expect(error.message).not.toContain(`(${level})`);
    },
  );

  it('accepts an IPv6 HOST', () => {
    expect(validateEnv({ ...BASE_ENV, HOST: '::1' }).HOST).toBe('::1');
  });

  it('names every invalid variable and omits their values', () => {
    const error = captureError(() =>
      validateEnv({
        ...BASE_ENV,
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

describe('validateEnv DATABASE_URL', () => {
  it('is required and has no default', () => {
    const error = captureError(() => validateEnv({}));

    expect(error.variables).toEqual(['DATABASE_URL']);
    expect(error.message).toBe(
      'Invalid environment configuration: DATABASE_URL (invalid_type)',
    );
  });

  it.each([
    'postgres://user:pass@localhost:5432/db',
    'postgresql://user:pass@localhost:5432/db',
    'postgresql://user:pass@[::1]:5432/db?sslmode=require',
  ])('accepts %s', (url) => {
    expect(validateEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it.each([
    ['empty', ''],
    ['not a URL', `not a url ${DB_PASSWORD}`],
    [
      'another database scheme',
      `mysql://app_user:${DB_PASSWORD}@db.internal/x`,
    ],
    ['an HTTP URL', `https://app_user:${DB_PASSWORD}@db.internal/x`],
  ])('rejects a value that is %s without echoing it', (_label, url) => {
    const error = captureError(() => validateEnv({ DATABASE_URL: url }));

    expect(error.variables).toEqual(['DATABASE_URL']);
    expect(error.message).toBe(
      'Invalid environment configuration: DATABASE_URL (invalid_format)',
    );
    expect(error.message).not.toContain(DB_PASSWORD);
  });

  it('keeps the password out of the message when another variable is invalid', () => {
    const error = captureError(() => validateEnv({ ...BASE_ENV, PORT: 'abc' }));

    expect(error.variables).toEqual(['PORT']);
    expect(error.message).not.toContain(DB_PASSWORD);
    expect(error.message).not.toContain('DATABASE_URL');
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
