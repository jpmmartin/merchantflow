-- Adds REQUIRES_ACTION as a payment intent status: the customer must complete a
-- step, such as 3D Secure, before the provider decides the payment. The check is
-- replaced in one statement; every existing row satisfies the new list, which
-- mirrors PAYMENT_INTENT_STATUSES in packages/domain.

ALTER TABLE payment_intents
  DROP CONSTRAINT payment_intents_status_check,
  ADD CONSTRAINT payment_intents_status_check CHECK (
    status IN ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REQUIRES_ACTION')
  );
