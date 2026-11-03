import { ApiException } from '../../errors/api/api-exception.js';

/** Every way a merchant use case can refuse a request. */
export type MerchantFailureCode =
  | 'MERCHANT_NOT_FOUND'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'TRANSITION_NOT_ALLOWED'
  | 'STATUS_CONFLICT';

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
  }
}
