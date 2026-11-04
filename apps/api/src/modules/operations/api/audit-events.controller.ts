import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../../auth/api/current-principal.decorator.js';
import { Roles } from '../../auth/api/route-access.js';
import type { Principal } from '../../auth/application/principal.js';
import { ApiErrorResponses } from '../../errors/api/api-error-responses.decorator.js';
import { ListAuditLogService } from '../application/list-audit-log.service.js';
import { toAuditEventListResponse } from './operations.presenter.js';
import {
  auditEventListResponseSchema,
  listAuditEventsQuerySchema,
  type AuditEventListResponse,
  type ListAuditEventsQuery,
} from './operations.schemas.js';

@ApiTags('Audit')
@ApiBearerAuth('bearer')
@Controller('audit-events')
export class AuditEventsController {
  constructor(private readonly listAuditLog: ListAuditLogService) {}

  // The request names no merchant, so listing every role here reveals
  // nothing (AD-52): the scope comes only from the principal.
  @Get()
  @Roles(['PLATFORM_ADMIN', 'MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: 'List audit events',
    description:
      'Roles: PLATFORM_ADMIN lists every event, including those that concern no merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY list only the events of their own merchant, never one with no merchant. Pages are ordered newest first, by occurrence time and then id, and continue with next_cursor; the cursor does not carry the filters, so a client that changes a filter starts again without it. action keeps one action; from (inclusive) and to (exclusive) bound the occurrence time. Each event has a readable actor, a summary, and only the reviewed metadata fields. A list writes no audit event.',
  })
  @ApiResponse({
    status: 200,
    description: 'One page of events.',
    standardSchema: auditEventListResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED: limit is not an integer from 1 to 100, cursor is not a next_cursor of this API, action is not a recorded action, from or to is not an ISO 8601 instant with Z or an offset, to is not after from, or the query names an unknown parameter. The issues name each field.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired, or the user is disabled.',
    },
  )
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: listAuditEventsQuerySchema }) query: ListAuditEventsQuery,
  ): Promise<AuditEventListResponse> {
    const page = await this.listAuditLog.execute({
      principal,
      limit: query.limit,
      after: query.cursor,
      action: query.action,
      from: query.from,
      to: query.to,
    });
    return toAuditEventListResponse(page);
  }
}
