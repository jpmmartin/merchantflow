import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ApiExceptionFilter } from './api/api-exception.filter.js';
import { createValidationException } from './api/validation-issues.js';

/**
 * Registers the error contract for the whole application: the filter that
 * shapes every error response, and the pipe that validates `@Body`, `@Query`,
 * and `@Param` against their Standard Schema (Zod) and reports failures
 * through that filter.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({
        exceptionFactory: createValidationException,
      }),
    },
  ],
})
export class ErrorsModule {}
