import {
  parsePositiveMoney,
  type ParsePositiveMoneyFailure,
  type PositiveMoney,
} from '@merchantflow/domain';
import { ApiException } from '../../errors/api/api-exception.js';
import type { ValidationIssue } from '../../errors/api/error-response.js';
import type { CreatePaymentIntentFailureCode } from '../application/create-payment-intent.service.js';
import type { GetPaymentIntentResult } from '../application/get-payment-intent.service.js';
import type { ListPaymentIntentsResult } from '../application/list-payment-intents.service.js';
import type { CreatePaymentIntentBody } from './payment-intent.schemas.js';

/** The exception for a refused create request. */
export function toApiException(
  code: CreatePaymentIntentFailureCode,
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'MERCHANT_NOT_ACTIVE':
      return new ApiException('MERCHANT_NOT_ACTIVE');
    case 'CURRENCY_MISMATCH':
      return new ApiException('MERCHANT_CURRENCY_MISMATCH');
    case 'DUPLICATE_MERCHANT_REFERENCE':
      return new ApiException('DUPLICATE_MERCHANT_REFERENCE');
    case 'OPERATION_IN_PROGRESS':
      return new ApiException('OPERATION_IN_PROGRESS');
    case 'KEY_REUSED':
      return new ApiException('IDEMPOTENCY_KEY_REUSED');
    case 'LOCK_TIMEOUT':
      return new ApiException('OPERATION_TIMEOUT');
  }
}

/** The exception for a refused read request. */
export function toGetApiException(
  code: Extract<GetPaymentIntentResult, { ok: false }>['code'],
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'NOT_FOUND':
      return new ApiException('NOT_FOUND');
  }
}

/** The exception for a refused list request. */
export function toListApiException(
  code: Extract<ListPaymentIntentsResult, { ok: false }>['code'],
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
  }
}

/**
 * The issue of a rejected amount or currency: the field and the domain's
 * reason in lower case, for example `leading_zero`, never the value.
 */
function moneyIssue(failure: ParsePositiveMoneyFailure): ValidationIssue {
  switch (failure.code) {
    case 'UNSUPPORTED_CURRENCY':
      return { path: ['currency'], code: 'invalid_value' };
    case 'NOT_A_STRING':
    case 'EMPTY':
    case 'INVALID_FORMAT':
    case 'LEADING_ZERO':
    case 'OUT_OF_RANGE':
    case 'NOT_POSITIVE':
      return { path: ['amount_minor'], code: failure.code.toLowerCase() };
  }
}

/**
 * The amount of a request as `PositiveMoney`, parsed by the domain from the
 * integer string without passing through `number`. A rejected amount is
 * `400 VALIDATION_FAILED` with one issue that names the reason.
 */
export function amountOf(body: CreatePaymentIntentBody): PositiveMoney {
  const parsed = parsePositiveMoney(body.amount_minor, body.currency);
  if (!parsed.ok) {
    throw new ApiException('VALIDATION_FAILED', [moneyIssue(parsed)]);
  }
  return parsed.money;
}
