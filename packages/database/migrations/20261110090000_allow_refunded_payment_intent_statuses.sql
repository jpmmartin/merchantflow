-- Adds PARTIALLY_REFUNDED and REFUNDED as payment intent statuses: a captured
-- payment (SUCCEEDED) moves to one of them once part or all of its amount was
-- refunded. The check is replaced in one statement; every existing row
-- satisfies the new list, which mirrors PAYMENT_INTENT_STATUSES in
-- packages/domain.

ALTER TABLE payment_intents
  DROP CONSTRAINT payment_intents_status_check,
  ADD CONSTRAINT payment_intents_status_check CHECK (
    status IN (
      'CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REQUIRES_ACTION',
      'PARTIALLY_REFUNDED', 'REFUNDED'
    )
  );
