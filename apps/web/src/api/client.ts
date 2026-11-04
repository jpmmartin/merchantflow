import { API_BASE_URL } from '../config';
import { clearSessionToken, readSessionToken } from '../session-token';

/** One invalid field of a `VALIDATION_FAILED` answer: where, and which rule. */
export interface ApiValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
}

/**
 * A failed API call. `code` is the API's stable error code, or `NETWORK_ERROR`
 * and `INVALID_RESPONSE` for failures before an API answer could be read.
 * `correlationId` is the one the API returned, when there was an answer, and
 * `issues` lists the invalid fields of a validation failure.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly code: string,
    message: string,
    readonly correlationId: string | undefined,
    readonly issues: readonly ApiValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type UnauthorizedListener = () => void;

let unauthorizedListener: UnauthorizedListener | undefined;

/**
 * Registers what happens when an authenticated call answers 401: the stored
 * token is already cleared, and the app returns to the sign-in screen.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListener = listener;
  return () => {
    if (unauthorizedListener === listener) unauthorizedListener = undefined;
  };
}

interface RequestOptions {
  readonly body?: unknown;
  /** Extra request headers, such as `Idempotency-Key`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** `false` for calls that need no session, such as sign-in. */
  readonly authenticated?: boolean;
}

/** The issues of an error body, keeping only entries of the documented shape. */
function readIssues(error: object): readonly ApiValidationIssue[] {
  if (!('issues' in error) || !Array.isArray(error.issues)) return [];
  const issues: ApiValidationIssue[] = [];
  for (const issue of error.issues as readonly unknown[]) {
    if (
      typeof issue === 'object' &&
      issue !== null &&
      'path' in issue &&
      Array.isArray(issue.path) &&
      (issue.path as readonly unknown[]).every(
        (part) => typeof part === 'string' || typeof part === 'number',
      ) &&
      'code' in issue &&
      typeof issue.code === 'string'
    ) {
      issues.push({
        path: issue.path as readonly (string | number)[],
        code: issue.code,
      });
    }
  }
  return issues;
}

/** The error body every API failure has (`{ error: { code, ... } }`). */
function readErrorBody(body: unknown):
  | {
      code: string;
      message: string;
      correlationId?: string;
      issues: readonly ApiValidationIssue[];
    }
  | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }
  const { error } = body;
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !('message' in error) ||
    typeof error.message !== 'string'
  ) {
    return undefined;
  }
  return {
    code: error.code,
    message: error.message,
    ...('correlationId' in error && typeof error.correlationId === 'string'
      ? { correlationId: error.correlationId }
      : {}),
    issues: readIssues(error),
  };
}

/**
 * Calls the API. Every call of the app goes through here: it prefixes the base
 * URL, sends JSON, adds the session token as `Authorization: Bearer`, and turns
 * any non-2xx answer into an `ApiError` carrying the code and correlation ID. A
 * 401 on an authenticated call clears the token and notifies the app.
 *
 * The response body is returned as parsed JSON, or `undefined` for 204.
 */
export async function apiRequest(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const authenticated = options.authenticated ?? true;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = authenticated ? readSessionToken() : undefined;
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(
      undefined,
      'NETWORK_ERROR',
      'The API could not be reached.',
      undefined,
    );
  }

  const headerCorrelationId =
    response.headers.get('X-Correlation-Id') ?? undefined;
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      'The API answer could not be read.',
      headerCorrelationId,
    );
  }

  if (response.ok) return body;

  if (response.status === 401 && authenticated) {
    clearSessionToken();
    unauthorizedListener?.();
  }
  const error = readErrorBody(body);
  throw new ApiError(
    response.status,
    error?.code ?? 'INVALID_RESPONSE',
    error?.message ?? `The API answered with status ${response.status}.`,
    error?.correlationId ?? headerCorrelationId,
    error?.issues ?? [],
  );
}

/** One event of a `text/event-stream` response. */
export interface StreamEvent {
  /** The `event` field, or `message` when the event names none. */
  readonly type: string;
  /** The `id` field, or `undefined` when the event has none. */
  readonly id: string | undefined;
  /** The `data` lines joined with a newline. */
  readonly data: string;
}

interface StreamOptions {
  /** Aborting it closes the stream; the returned promise then resolves. */
  readonly signal: AbortSignal;
  readonly onEvent: (event: StreamEvent) => void;
  /**
   * Called for every line the server sends, keep-alive comments included,
   * but not for the blank line that only opens the stream.
   */
  readonly onActivity?: () => void;
}

/**
 * Reads a Server-Sent Events stream of the API with `fetch` and a
 * `ReadableStream`, because the browser's `EventSource` cannot send the
 * `Authorization` header and a token must never go in the URL. It sends the
 * session token as `Authorization: Bearer`, like every other call.
 *
 * It resolves when the server ends the stream or the signal aborts it, and
 * rejects with an `ApiError` for an answer that is not a 2xx event stream
 * (with the API's code and correlation ID), or with `NETWORK_ERROR` when the
 * connection fails. A 401 clears the token and notifies the app, as in
 * `apiRequest`. The event stream format: lines `field: value`, a line that
 * starts with `:` is a comment, and a blank line ends an event.
 */
export async function apiEventStream(
  path: string,
  options: StreamOptions,
): Promise<void> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  const token = readSessionToken();
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: options.signal,
    });
  } catch {
    if (options.signal.aborted) return;
    throw new ApiError(
      undefined,
      'NETWORK_ERROR',
      'The API could not be reached.',
      undefined,
    );
  }

  const headerCorrelationId =
    response.headers.get('X-Correlation-Id') ?? undefined;
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!response.ok || !contentType.startsWith('text/event-stream')) {
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = undefined;
    }
    if (response.status === 401) {
      clearSessionToken();
      unauthorizedListener?.();
    }
    const error = readErrorBody(body);
    throw new ApiError(
      response.status,
      error?.code ?? 'INVALID_RESPONSE',
      error?.message ?? `The API answered with status ${response.status}.`,
      error?.correlationId ?? headerCorrelationId,
      error?.issues ?? [],
    );
  }
  if (response.body === null) return;

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let type = '';
  let id: string | undefined;
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0) {
      options.onEvent({
        type: type === '' ? 'message' : type,
        id,
        data: data.join('\n'),
      });
    }
    type = '';
    id = undefined;
    data = [];
  };
  const readLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    options.onActivity?.();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        type = value;
        break;
      case 'data':
        data.push(value);
        break;
      case 'id':
        id = value;
        break;
      default:
        break;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';
      lines.forEach(readLine);
    }
  } catch {
    if (options.signal.aborted) return;
    throw new ApiError(
      undefined,
      'NETWORK_ERROR',
      'The notification stream was interrupted.',
      headerCorrelationId,
    );
  } finally {
    reader.releaseLock();
  }
}
