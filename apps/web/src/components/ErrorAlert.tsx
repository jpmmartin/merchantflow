import { ApiError } from '../api/client';

interface ErrorAlertProps {
  readonly error: unknown;
}

/**
 * Shows a failed call: the API's message, its error code, and the correlation
 * ID to quote when reporting the problem.
 */
export function ErrorAlert({ error }: ErrorAlertProps) {
  if (error === undefined || error === null) return null;
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(
          undefined,
          'CLIENT_ERROR',
          'Something went wrong in the browser.',
          undefined,
        );
  return (
    <div className="alert alert-danger" role="alert">
      <div>{apiError.message}</div>
      <div className="small mt-1">
        Code <code>{apiError.code}</code>
        {apiError.correlationId === undefined ? null : (
          <>
            {' '}
            · Correlation ID <code>{apiError.correlationId}</code>
          </>
        )}
      </div>
    </div>
  );
}
