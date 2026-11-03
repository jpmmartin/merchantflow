import type { StandardSchemaValidationPipeOptions } from '@nestjs/common';
import { ApiException } from './api-exception.js';
import type { ValidationIssue } from './error-response.js';

type StandardSchemaIssue = Parameters<
  NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>
>[0][number];

/**
 * Converts one Standard Schema issue into the public shape. The message and
 * any received value are dropped: only the field path and the rule code leave
 * the server. The Standard Schema type has no rule code, so it is read from the
 * issue when the library provides one (Zod does) and is `invalid` otherwise.
 */
function toValidationIssue(issue: StandardSchemaIssue): ValidationIssue {
  const code = (issue as { code?: unknown }).code;
  return {
    path: (issue.path ?? []).map((segment) => {
      const key = typeof segment === 'object' ? segment.key : segment;
      return typeof key === 'number' ? key : String(key);
    }),
    code: typeof code === 'string' ? code : 'invalid',
  };
}

/** Builds the exception that `StandardSchemaValidationPipe` throws. */
export function createValidationException(
  issues: readonly StandardSchemaIssue[],
): ApiException {
  return new ApiException('VALIDATION_FAILED', issues.map(toValidationIssue));
}
