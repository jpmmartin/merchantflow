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
