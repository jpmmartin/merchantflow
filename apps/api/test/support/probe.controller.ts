import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';

export const INTERNAL_FAILURE_MESSAGE = 'internal-failure-detail-5b8e1f';

const createItemSchema = z.strictObject({
  name: z.string().min(30),
  quantity: z.int().positive(),
  kind: z.enum(['physical', 'digital']),
  tags: z.array(z.string().max(8)).optional(),
});

const itemIdSchema = z.uuid();

const listItemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Routes that exist only in tests. They exercise validation, the error
 * mapping, and the OpenAPI generation without adding a business endpoint to
 * the production code.
 */
@Controller('probe')
export class ProbeController {
  @Post('items')
  createItem(@Body({ schema: createItemSchema }) body: unknown) {
    return { created: body };
  }

  @Get('items/:id')
  getItem(
    @Param('id', { schema: itemIdSchema }) id: string,
    @Query({ schema: listItemsQuerySchema })
    query: z.infer<typeof listItemsQuerySchema>,
  ) {
    return { id, limit: query.limit };
  }

  @Get('crash')
  crash(): never {
    throw new Error(INTERNAL_FAILURE_MESSAGE);
  }

  @Get('crash-service')
  crashService(): never {
    throw new ServiceUnavailableException(INTERNAL_FAILURE_MESSAGE);
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException(INTERNAL_FAILURE_MESSAGE);
  }
}
