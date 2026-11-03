import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { errorResponseSchema } from './error-response.js';

interface DocumentedError {
  readonly status: number;
  readonly description: string;
}

/**
 * Documents the error responses of a route in OpenAPI, each with the shared
 * error body. The description should name the codes the route can return.
 */
export function ApiErrorResponses(...errors: readonly DocumentedError[]) {
  return applyDecorators(
    ...errors.map((error) =>
      ApiResponse({
        status: error.status,
        description: error.description,
        standardSchema: errorResponseSchema,
      }),
    ),
  );
}
