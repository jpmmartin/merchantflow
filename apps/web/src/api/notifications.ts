import { apiEventStream, apiRequest, type StreamEvent } from './client';

export type NotificationType =
  | 'REFUND_SUCCEEDED'
  | 'REFUND_FAILED'
  | 'REFUND_REVERSED'
  | 'REFUND_PENDING'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_AUTHORIZED'
  | 'PAYMENT_UNSUCCESSFUL'
  | 'CAPTURE_SUCCEEDED'
  | 'CAPTURE_FAILED'
  | 'VOID_SUCCEEDED'
  | 'VOID_FAILED';

/** A notification of a payment or refund change made without the user. */
export interface AppNotification {
  readonly id: string;
  readonly merchant_id: string;
  readonly type: NotificationType;
  readonly payment_intent_id: string;
  readonly refund_id: string | null;
  readonly amount_minor: string;
  readonly currency: string;
  readonly summary: string;
  readonly created_at: string;
  readonly read_at: string | null;
}

export interface NotificationList {
  readonly data: readonly AppNotification[];
  readonly next_cursor: string | null;
  readonly unread_count: number;
}

export interface NotificationsRead {
  readonly marked: number;
  readonly unread_count: number;
}

/** The newest page of the tray, or the page after `cursor`. */
export async function listNotifications(
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<NotificationList> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  return (await apiRequest(
    'GET',
    `/notifications${suffix}`,
  )) as NotificationList;
}

export async function markNotificationRead(
  id: string,
): Promise<NotificationsRead> {
  return (await apiRequest(
    'POST',
    `/notifications/${encodeURIComponent(id)}/read`,
  )) as NotificationsRead;
}

export async function markAllNotificationsRead(): Promise<NotificationsRead> {
  return (await apiRequest(
    'POST',
    '/notifications/read-all',
  )) as NotificationsRead;
}

/** The error body the stream sends as an `error` event before it ends. */
export interface StreamFailure {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string | undefined;
}

function readStreamFailure(event: StreamEvent): StreamFailure {
  try {
    const body = JSON.parse(event.data) as {
      error?: { code?: unknown; message?: unknown; correlationId?: unknown };
    };
    const error = body.error ?? {};
    return {
      code: typeof error.code === 'string' ? error.code : 'INVALID_RESPONSE',
      message:
        typeof error.message === 'string'
          ? error.message
          : 'The notification stream failed.',
      correlationId:
        typeof error.correlationId === 'string'
          ? error.correlationId
          : undefined,
    };
  } catch {
    return {
      code: 'INVALID_RESPONSE',
      message: 'The notification stream failed.',
      correlationId: undefined,
    };
  }
}

/**
 * Opens the notification stream once and reads it until the server ends it,
 * the connection fails, or `signal` aborts it. `after` resumes after the last
 * notification received: the API sends what came after it first.
 */
export async function readNotificationStream(options: {
  readonly after: string | undefined;
  readonly signal: AbortSignal;
  readonly onNotification: (notification: AppNotification) => void;
  readonly onFailure: (failure: StreamFailure) => void;
  readonly onActivity: () => void;
}): Promise<void> {
  const suffix =
    options.after === undefined
      ? ''
      : `?after=${encodeURIComponent(options.after)}`;
  await apiEventStream(`/notifications/stream${suffix}`, {
    signal: options.signal,
    onActivity: options.onActivity,
    onEvent: (event) => {
      if (event.type === 'notification') {
        options.onNotification(JSON.parse(event.data) as AppNotification);
      } else if (event.type === 'error') {
        options.onFailure(readStreamFailure(event));
      }
    },
  });
}
