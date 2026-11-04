-- Lets a refund that the provider reported as succeeded and later failed be
-- recorded as such, as the owner approved on 2026-11-03:
--
-- 1. A SUCCEEDED refund may move to FAILED, and only to FAILED; the identity,
--    the amount, and the provider refund ID still never change, a FAILED
--    refund is still final, and nothing returns to EXECUTING.
-- 2. The ledger gains the PAYMENT_REFUND_REVERSAL source type, whose source is
--    the refund and which, like a refund, always names its payment intent. Its
--    unique source reference posts the compensating entry of a refund once.

CREATE OR REPLACE FUNCTION refunds_reject_invalid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.payment_intent_id, NEW.payment_attempt_id,
      NEW.processor_account_id, NEW.operation_id, NEW.idempotency_record_id,
      NEW.amount_minor, NEW.currency, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.payment_intent_id, OLD.payment_attempt_id,
      OLD.processor_account_id, OLD.operation_id, OLD.idempotency_record_id,
      OLD.amount_minor, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'refunds: the identity of a refund cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'FAILED' THEN
    RAISE EXCEPTION 'refunds: a finished refund cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'SUCCEEDED' AND NEW.status <> 'FAILED' THEN
    RAISE EXCEPTION 'refunds: a succeeded refund can only fail afterwards'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL
     AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'refunds: a provider refund ID cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'EXECUTING' AND OLD.status <> 'EXECUTING' THEN
    RAISE EXCEPTION 'refunds: a refund cannot return to EXECUTING'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE refunds IS 'Refunds of captured payment intents. Rows are never deleted; a failed refund never changes, and a succeeded refund can only fail afterwards.';

ALTER TABLE journal_entries
  DROP CONSTRAINT journal_entries_source_type_check,
  ADD CONSTRAINT journal_entries_source_type_check CHECK (
    source_type IN ('PAYMENT_SALE', 'PAYMENT_REFUND', 'PAYMENT_REFUND_REVERSAL')
  ),
  DROP CONSTRAINT journal_entries_payment_source_check,
  ADD CONSTRAINT journal_entries_payment_source_check CHECK (
    source_type NOT IN ('PAYMENT_SALE', 'PAYMENT_REFUND', 'PAYMENT_REFUND_REVERSAL')
    OR payment_intent_id IS NOT NULL
  );
