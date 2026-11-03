import { z } from 'zod';
import { ERROR_CODES } from './error-codes.js';

/** One invalid field: where it is and which rule it broke, never its value. */
export const validationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
});

/**
 * The body of every error response: `error.code` is stable and machine
 * readable, `error.message` is safe to display, and `error.correlationId`
 * equals the `X-Correlation-Id` response header. `issues` appears only for
 * validation failures.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    correlationId: z.string(),
    issues: z.array(validationIssueSchema).optional(),
  }),
});

export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
