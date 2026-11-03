import { HttpException } from '@nestjs/common';
import { ERROR_DEFINITIONS, type ErrorCode } from './error-codes.js';
import type { ValidationIssue } from './error-response.js';

/**
 * Raises an expected failure with a stable code. The status comes from the
 * code, so the two cannot disagree, and the exception filter builds the
 * response from the code alone.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    readonly issues?: readonly ValidationIssue[],
  ) {
    super(code, ERROR_DEFINITIONS[code].status);
  }
}
