-- Adds the attempt statuses of a manual capture (P-08).
--
-- AUTHORIZED: the provider authorized the payment of a MANUAL intent and holds
-- the funds; nothing is captured yet. A capture moves the attempt to
-- SUCCEEDED, the status of a captured payment, and a void moves it to
-- CANCELED. Both are final.

ALTER TABLE payment_attempts
  DROP CONSTRAINT payment_attempts_status_check,
  ADD CONSTRAINT payment_attempts_status_check CHECK (
    status IN (
      'EXECUTING', 'REQUIRES_ACTION', 'SUCCEEDED', 'DECLINED', 'FAILED', 'UNKNOWN',
      'AUTHORIZED', 'CANCELED'
    )
  ),
  -- A charge, a hold, a released hold, and a pending customer action are
  -- always identified at the provider.
  DROP CONSTRAINT payment_attempts_provider_transaction_required_check,
  ADD CONSTRAINT payment_attempts_provider_transaction_required_check CHECK (
    status NOT IN ('REQUIRES_ACTION', 'SUCCEEDED', 'AUTHORIZED', 'CANCELED')
    OR provider_transaction_id IS NOT NULL
  );

-- At most one attempt per intent that authorized its funds: an authorized
-- hold, a captured payment, or a voided hold. Replaces the index of
-- 20261108090100, which covered SUCCEEDED only, under the same name.
DROP INDEX payment_attempts_one_succeeded_per_intent_idx;
CREATE UNIQUE INDEX payment_attempts_one_succeeded_per_intent_idx
  ON payment_attempts (payment_intent_id)
  WHERE status IN ('AUTHORIZED', 'SUCCEEDED', 'CANCELED');

-- What an attempt is never changes, a provider transaction ID once learned is
-- kept, nothing returns to EXECUTING, only an executing attempt can come to
-- require customer action, an attempt is authorized only while its outcome is
-- open, an authorized attempt can only be captured (SUCCEEDED) or voided
-- (CANCELED), and a finished attempt (SUCCEEDED, DECLINED, FAILED, or
-- CANCELED) is never updated again. Replaces the function of 20261108090100.
CREATE OR REPLACE FUNCTION payment_attempts_reject_invalid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.payment_intent_id, NEW.processor_account_id,
      NEW.operation_id, NEW.idempotency_record_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.payment_intent_id, OLD.processor_account_id,
      OLD.operation_id, OLD.idempotency_record_id, OLD.created_at) THEN
    RAISE EXCEPTION 'payment_attempts: the identity of an attempt cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'DECLINED', 'FAILED', 'CANCELED') THEN
    RAISE EXCEPTION 'payment_attempts: a finished attempt cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.provider_transaction_id IS NOT NULL
     AND NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id THEN
    RAISE EXCEPTION 'payment_attempts: a provider transaction ID cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'EXECUTING' AND OLD.status <> 'EXECUTING' THEN
    RAISE EXCEPTION 'payment_attempts: an attempt cannot return to EXECUTING'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'REQUIRES_ACTION' AND OLD.status NOT IN ('EXECUTING', 'REQUIRES_ACTION') THEN
    RAISE EXCEPTION 'payment_attempts: only an executing attempt can require customer action'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'AUTHORIZED'
     AND OLD.status NOT IN ('EXECUTING', 'REQUIRES_ACTION', 'UNKNOWN', 'AUTHORIZED') THEN
    RAISE EXCEPTION 'payment_attempts: only an attempt with an open outcome can be authorized'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'AUTHORIZED' AND NEW.status NOT IN ('AUTHORIZED', 'SUCCEEDED', 'CANCELED') THEN
    RAISE EXCEPTION 'payment_attempts: an authorized attempt can only be captured or voided'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'CANCELED' AND OLD.status <> 'AUTHORIZED' THEN
    RAISE EXCEPTION 'payment_attempts: only an authorized attempt can be voided'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
