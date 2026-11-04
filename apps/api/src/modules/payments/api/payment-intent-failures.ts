import {
  parseAmountMinor,
  parsePositiveMoney,
  type ParsePositiveMoneyFailure,
  type PositiveMoney,
} from '@merchantflow/domain';
import { ApiException } from '../../errors/api/api-exception.js';
import type { ValidationIssue } from '../../errors/api/error-response.js';
import type { CompletePaymentActionFailureCode } from '../application/complete-payment-action.service.js';
import type { ConfirmPaymentIntentFailureCode } from '../application/confirm-payment-intent.service.js';
import type { CreatePaymentIntentFailureCode } from '../application/create-payment-intent.service.js';
import type { GetPaymentIntentResult } from '../application/get-payment-intent.service.js';
import type { ListPaymentAttemptsResult } from '../application/list-payment-attempts.service.js';
import type { ListPaymentIntentsResult } from '../application/list-payment-intents.service.js';
import type { ListRefundsResult } from '../application/list-refunds.service.js';
import type { RefundPaymentIntentFailureCode } from '../application/refund-payment-intent.service.js';
import type { CreatePaymentIntentBody } from './payment-intent.schemas.js';
import type { CreateRefundBody } from './refund.schemas.js';

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

/** The exception for a refused confirmation. */
export function toConfirmApiException(
  code: ConfirmPaymentIntentFailureCode,
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'NOT_FOUND':
      return new ApiException('NOT_FOUND');
    case 'MERCHANT_NOT_ACTIVE':
      return new ApiException('MERCHANT_NOT_ACTIVE');
    case 'OPERATION_IN_PROGRESS':
      return new ApiException('OPERATION_IN_PROGRESS');
    case 'KEY_REUSED':
      return new ApiException('IDEMPOTENCY_KEY_REUSED');
    case 'LOCK_TIMEOUT':
      return new ApiException('OPERATION_TIMEOUT');
    case 'PAYMENT_OUTCOME_UNKNOWN':
      return new ApiException('PAYMENT_OUTCOME_UNKNOWN');
    case 'ATTEMPT_IN_PROGRESS':
      return new ApiException('PAYMENT_ATTEMPT_IN_PROGRESS');
    case 'INTENT_NOT_CONFIRMABLE':
      return new ApiException('PAYMENT_INTENT_NOT_CONFIRMABLE');
    case 'PROCESSOR_ACCOUNT_NOT_FOUND':
      return new ApiException('PROCESSOR_ACCOUNT_NOT_FOUND');
    case 'PROCESSOR_ACCOUNT_DISABLED':
      return new ApiException('PROCESSOR_ACCOUNT_DISABLED');
    case 'PROCESSOR_ACCOUNT_NOT_DEFAULT':
      return new ApiException('PROCESSOR_ACCOUNT_NOT_DEFAULT');
    case 'CREDENTIALS_KEY_NOT_CONFIGURED':
      return new ApiException('CREDENTIALS_KEY_NOT_CONFIGURED');
    case 'PROVIDER_UNSUPPORTED':
      return new ApiException('PROCESSOR_PROVIDER_UNSUPPORTED');
  }
}

/** The exception for a refused completion of a customer action. */
export function toCompleteActionApiException(
  code: CompletePaymentActionFailureCode,
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'NOT_FOUND':
      return new ApiException('NOT_FOUND');
    case 'ACTION_NOT_PENDING':
      return new ApiException('PAYMENT_ACTION_NOT_PENDING');
    case 'CREDENTIALS_KEY_NOT_CONFIGURED':
      return new ApiException('CREDENTIALS_KEY_NOT_CONFIGURED');
    case 'PROVIDER_UNSUPPORTED':
      return new ApiException('PROCESSOR_PROVIDER_UNSUPPORTED');
    case 'LOOKUP_UNAVAILABLE':
      return new ApiException('PROCESSOR_LOOKUP_UNAVAILABLE');
  }
}

/** The exception for a refused list of attempts. */
export function toListAttemptsApiException(
  code: Extract<ListPaymentAttemptsResult, { ok: false }>['code'],
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'NOT_FOUND':
      return new ApiException('NOT_FOUND');
  }
}

/**
 * The amount of a refund request in minor units, parsed by the domain from
 * the integer string without passing through `number`, and greater than
 * zero. A rejected amount is `400 VALIDATION_FAILED` with one issue that names
 * the reason (`empty`, `invalid_format`, `leading_zero`, `out_of_range`, or
 * `not_positive`), never the value.
 */
export function refundAmountMinorOf(body: CreateRefundBody): bigint {
  const parsed = parseAmountMinor(body.amount_minor);
  if (!parsed.ok) {
    throw new ApiException('VALIDATION_FAILED', [
      { path: ['amount_minor'], code: parsed.code.toLowerCase() },
    ]);
  }
  if (parsed.amountMinor <= 0n) {
    throw new ApiException('VALIDATION_FAILED', [
      { path: ['amount_minor'], code: 'not_positive' },
    ]);
  }
  return parsed.amountMinor;
}

/** The exception for a refused refund. */
export function toRefundApiException(
  code: RefundPaymentIntentFailureCode,
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'NOT_FOUND':
      return new ApiException('NOT_FOUND');
    case 'MERCHANT_NOT_ACTIVE':
      return new ApiException('MERCHANT_NOT_ACTIVE');
    case 'OPERATION_IN_PROGRESS':
      return new ApiException('OPERATION_IN_PROGRESS');
    case 'KEY_REUSED':
      return new ApiException('IDEMPOTENCY_KEY_REUSED');
    case 'LOCK_TIMEOUT':
      return new ApiException('OPERATION_TIMEOUT');
    case 'INTENT_NOT_REFUNDABLE':
      return new ApiException('PAYMENT_INTENT_NOT_REFUNDABLE');
    case 'REFUND_OUTCOME_UNKNOWN':
      return new ApiException('REFUND_OUTCOME_UNKNOWN');
    case 'AMOUNT_EXCEEDS_REFUNDABLE':
      return new ApiException('REFUND_AMOUNT_EXCEEDS_REFUNDABLE');
    case 'CREDENTIALS_KEY_NOT_CONFIGURED':
      return new ApiException('CREDENTIALS_KEY_NOT_CONFIGURED');
    case 'PROVIDER_UNSUPPORTED':
      return new ApiException('PROCESSOR_PROVIDER_UNSUPPORTED');
  }
}

/** The exception for a refused list of refunds. */
export function toListRefundsApiException(
  code: Extract<ListRefundsResult, { ok: false }>['code'],
): ApiException {
  switch (code) {
    case 'FORBIDDEN':
      return new ApiException('INSUFFICIENT_ROLE');
    case 'NOT_FOUND':
      return new ApiException('NOT_FOUND');
  }
}
