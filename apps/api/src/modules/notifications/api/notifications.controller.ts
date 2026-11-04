import type { ServerResponse } from 'node:http';
import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { map, type Observable } from 'rxjs';
import { CurrentPrincipal } from '../../auth/api/current-principal.decorator.js';
import { Roles } from '../../auth/api/route-access.js';
import type { Principal } from '../../auth/application/principal.js';
import { ApiErrorResponses } from '../../errors/api/api-error-responses.decorator.js';
import { ApiException } from '../../errors/api/api-exception.js';
import { ERROR_DEFINITIONS } from '../../errors/api/error-codes.js';
import { CorrelationId } from '../../logging/correlation-id.decorator.js';
import { ListNotificationsService } from '../application/list-notifications.service.js';
import { MarkNotificationsReadService } from '../application/mark-notifications-read.service.js';
import {
  NOTIFICATION_STREAM_CHECK_INTERVAL_MILLIS,
  StreamNotificationsService,
  type NotificationStreamEvent,
} from '../application/stream-notifications.service.js';
import {
  toNotificationListResponse,
  toNotificationResponse,
} from './notification.presenter.js';
import {
  listNotificationsQuerySchema,
  notificationIdParamSchema,
  notificationListResponseSchema,
  notificationsReadResponseSchema,
  streamNotificationsQuerySchema,
  type ListNotificationsQuery,
  type NotificationListResponse,
  type NotificationsReadResponse,
  type StreamNotificationsQuery,
} from './notifications.schemas.js';

/** The answer to a refusal that every notification route shares. */
function refusal(
  code: 'SESSION_REQUIRED' | 'FORBIDDEN' | 'NOT_FOUND' | 'UNAUTHENTICATED',
): ApiException {
  return new ApiException(code === 'FORBIDDEN' ? 'INSUFFICIENT_ROLE' : code);
}

/** `after` names no notification of the merchant, whichever merchant it is of. */
function unknownAfter(): ApiException {
  return new ApiException('VALIDATION_FAILED', [
    { path: ['after'], code: 'unknown_notification' },
  ]);
}

const SESSION_ONLY =
  'Signed-in merchant users only: MERCHANT_ADMIN and MERCHANT_READ_ONLY with a session token; an API key gets 403 SESSION_REQUIRED, and PLATFORM_ADMIN 403 INSUFFICIENT_ROLE. The merchant comes only from the session.';

const UNAUTHENTICATED_DESCRIPTION =
  'UNAUTHENTICATED: the token is missing, malformed, unknown, wrong, revoked, or expired, or the user is disabled.';

const FORBIDDEN_DESCRIPTION =
  'SESSION_REQUIRED: the request was made with an API key. INSUFFICIENT_ROLE: a platform principal.';

/** The SSE message of a stream event. */
function toMessageEvent(
  event: NotificationStreamEvent,
  correlationId: string,
): MessageEvent {
  switch (event.kind) {
    case 'NOTIFICATION':
      return {
        id: event.notification.id,
        type: 'notification',
        data: toNotificationResponse(event.notification, null),
      };
    case 'KEEP_ALIVE':
      return { comment: 'keep-alive' };
    case 'FAILED':
      return {
        type: 'error',
        data: {
          error: {
            code: event.code,
            message: ERROR_DEFINITIONS[event.code].message,
            correlationId,
          },
        },
      };
  }
}

@ApiTags('Notifications')
@ApiBearerAuth('bearer')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly listNotifications: ListNotificationsService,
    private readonly markRead: MarkNotificationsReadService,
    private readonly streamNotifications: StreamNotificationsService,
  ) {}

  @Get()
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List notifications',
    description: `${SESSION_ONLY} Without after, a page of the tray newest first, continued with next_cursor (keyset pagination). With after (the ID of the last notification the client has), up to limit notifications after it, oldest first, to refill what a disconnected client missed; ask again from the last one while a full page comes back. Each item has the signed-in user's read time; unread_count counts the merchant's notifications that user has not read.`,
  })
  @ApiResponse({
    status: 200,
    description: 'One page of notifications and the unread count.',
    standardSchema: notificationListResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED: limit is not an integer from 1 to 100, cursor is not a next_cursor of this API, after is not a UUID or names no notification of the merchant (unknown_notification), after and cursor are both given, or the query names an unknown parameter.',
    },
    { status: 401, description: UNAUTHENTICATED_DESCRIPTION },
    { status: 403, description: FORBIDDEN_DESCRIPTION },
  )
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: listNotificationsQuerySchema })
    query: ListNotificationsQuery,
  ): Promise<NotificationListResponse> {
    const result = await this.listNotifications.execute({
      principal,
      limit: query.limit,
      cursor: query.cursor,
      after: query.after,
    });
    if (!result.ok) {
      throw result.code === 'AFTER_UNKNOWN'
        ? unknownAfter()
        : refusal(result.code);
    }
    return toNotificationListResponse(result);
  }

  @Post('read-all')
  @HttpCode(200)
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Mark every notification as read',
    description: `${SESSION_ONLY} Marks every notification of the merchant created until now as read for the signed-in user only. Safe to repeat.`,
  })
  @ApiResponse({
    status: 200,
    description: 'How many were marked, and the unread count left.',
    standardSchema: notificationsReadResponseSchema,
  })
  @ApiErrorResponses(
    { status: 401, description: UNAUTHENTICATED_DESCRIPTION },
    { status: 403, description: FORBIDDEN_DESCRIPTION },
  )
  async readAll(
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationsReadResponse> {
    const result = await this.markRead.markAll({ principal });
    if (!result.ok) throw refusal(result.code);
    return { marked: result.marked, unread_count: result.unreadCount };
  }

  @Post(':id/read')
  @HttpCode(200)
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Mark a notification as read',
    description: `${SESSION_ONLY} Marks one notification of the merchant as read for the signed-in user only; marking it again keeps the first read time.`,
  })
  @ApiResponse({
    status: 200,
    description: 'How many were marked (0 or 1), and the unread count left.',
    standardSchema: notificationsReadResponseSchema,
  })
  @ApiErrorResponses(
    { status: 400, description: 'VALIDATION_FAILED: id is not a UUID.' },
    { status: 401, description: UNAUTHENTICATED_DESCRIPTION },
    { status: 403, description: FORBIDDEN_DESCRIPTION },
    {
      status: 404,
      description:
        'NOT_FOUND: no notification of the merchant has this id, including one of another merchant.',
    },
  )
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: notificationIdParamSchema }) id: string,
  ): Promise<NotificationsReadResponse> {
    const result = await this.markRead.markOne({
      principal,
      notificationId: id,
    });
    if (!result.ok) throw refusal(result.code);
    return { marked: result.marked, unread_count: result.unreadCount };
  }

  @Sse('stream')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Stream new notifications (Server-Sent Events)',
    description: `${SESSION_ONLY} A text/event-stream response that stays open. Each new notification of the merchant is an event of type notification whose id is the notification ID and whose data is the notification as JSON (read_at null). A comment (": keep-alive") is sent every ${NOTIFICATION_STREAM_CHECK_INTERVAL_MILLIS / 1000} seconds, when the session is checked again: the stream ends when the session expires, and within that interval after it is revoked or its user is disabled; the client then gets 401 on reconnecting. A read failure sends an event of type error with the error body, then ends the stream. To resume after a lost connection, reconnect with after set to the last notification ID received: the notifications after it are sent first. Without after, the stream starts with the next new notification. The response is not cached or buffered (Cache-Control no-cache, X-Accel-Buffering no); a reverse proxy in front of the API must not buffer it and must allow idle reads longer than the keep-alive interval.`,
  })
  @ApiResponse({
    status: 200,
    description: 'The event stream.',
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED: after is not a UUID or names no notification of the merchant (unknown_notification), or the query names an unknown parameter.',
    },
    { status: 401, description: UNAUTHENTICATED_DESCRIPTION },
    { status: 403, description: FORBIDDEN_DESCRIPTION },
    {
      status: 503,
      description:
        'SERVICE_BUSY: the API is shutting down; retry after Retry-After seconds. The connection is closed.',
      headers: {
        'Retry-After': { description: 'Seconds to wait.', type: 'integer' },
      },
    },
  )
  async stream(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Query({ schema: streamNotificationsQuerySchema })
    query: StreamNotificationsQuery,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<Observable<MessageEvent>> {
    const result = await this.streamNotifications.execute({
      principal,
      correlationId,
      after: query.after,
    });
    if (!result.ok) {
      if (result.code === 'SHUTTING_DOWN') {
        // A client reconnecting on a kept-alive connection would otherwise
        // hold the HTTP server open; this answer closes the connection.
        response.setHeader('Connection', 'close');
        throw new ApiException('SERVICE_BUSY');
      }
      throw result.code === 'AFTER_UNKNOWN'
        ? unknownAfter()
        : refusal(result.code);
    }
    return result.events.pipe(
      map((event) => toMessageEvent(event, correlationId)),
    );
  }
}
