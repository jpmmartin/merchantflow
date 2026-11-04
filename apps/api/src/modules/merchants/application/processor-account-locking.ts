/**
 * How long a statement of a processor account change may wait for a lock,
 * such as the merchant row that serializes the changes of one merchant's
 * accounts. A longer wait ends the transaction with `lock_not_available`, and
 * the request is answered `503 OPERATION_TIMEOUT` with nothing changed.
 */
export const PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS = 2_000;
