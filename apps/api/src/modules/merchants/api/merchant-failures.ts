import { ApiException } from '../../errors/api/api-exception.js';

/** Every way a merchant use case can refuse a request. */
export type MerchantFailureCode =
  | 'MERCHANT_NOT_FOUND'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'TRANSITION_NOT_ALLOWED'
  | 'STATUS_CONFLICT'
  | 'EMAIL_TAKEN'
  | 'SELF_DISABLE'
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  | 'PROVIDER_UNSUPPORTED'
  | 'LIVE_CREDENTIALS'
  | 'INVALID_CREDENTIALS'
  | 'PROCESSOR_UNAVAILABLE'
  | 'ALREADY_CONNECTED'
  | 'DISABLED'
  | 'LOCK_TIMEOUT'
  | 'PUBLIC_BASE_URL_NOT_CONFIGURED'
  | 'ENDPOINT_REJECTED'
  | 'CONFIGURATION_CHANGED';

/**
 * The exception for a refused request. Both "not found" outcomes become the
 * one `NOT_FOUND` response, so a caller cannot tell a merchant or key that does
 * not exist from one that belongs to someone else.
 */
export function toApiException(code: MerchantFailureCode): ApiException {
  switch (code) {
    case 'MERCHANT_NOT_FOUND':
    case 'NOT_FOUND':
      return new ApiException('NOT_FOUND');
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'TRANSITION_NOT_ALLOWED':
      return new ApiException('MERCHANT_TRANSITION_NOT_ALLOWED');
    case 'STATUS_CONFLICT':
      return new ApiException('MERCHANT_STATUS_CONFLICT');
    case 'EMAIL_TAKEN':
      return new ApiException('USER_EMAIL_TAKEN');
    case 'SELF_DISABLE':
      return new ApiException('USER_SELF_DISABLE_NOT_ALLOWED');
    case 'CREDENTIALS_KEY_NOT_CONFIGURED':
      return new ApiException('CREDENTIALS_KEY_NOT_CONFIGURED');
    case 'PROVIDER_UNSUPPORTED':
      return new ApiException('PROCESSOR_PROVIDER_UNSUPPORTED');
    case 'LIVE_CREDENTIALS':
      return new ApiException('PROCESSOR_LIVE_CREDENTIALS_REJECTED');
    case 'INVALID_CREDENTIALS':
      return new ApiException('PROCESSOR_CREDENTIALS_INVALID');
    case 'PROCESSOR_UNAVAILABLE':
      return new ApiException('PROCESSOR_UNAVAILABLE');
    case 'ALREADY_CONNECTED':
      return new ApiException('PROCESSOR_ACCOUNT_ALREADY_CONNECTED');
    case 'DISABLED':
      return new ApiException('PROCESSOR_ACCOUNT_DISABLED');
    case 'LOCK_TIMEOUT':
      return new ApiException('OPERATION_TIMEOUT');
    case 'PUBLIC_BASE_URL_NOT_CONFIGURED':
      return new ApiException('PUBLIC_BASE_URL_NOT_CONFIGURED');
    case 'ENDPOINT_REJECTED':
      return new ApiException('WEBHOOK_ENDPOINT_REJECTED');
    case 'CONFIGURATION_CHANGED':
      return new ApiException('WEBHOOK_CONFIGURATION_CHANGED');
  }
}

/**
 * The exception for a refused webhook configuration change. A provider that
 * gave no usable answer has its own code here, because the message of
 * `PROCESSOR_UNAVAILABLE` is about credential validation.
 */
export function toWebhookApiException(code: MerchantFailureCode): ApiException {
  return code === 'PROCESSOR_UNAVAILABLE'
    ? new ApiException('WEBHOOK_PROVIDER_UNAVAILABLE')
    : toApiException(code);
}
