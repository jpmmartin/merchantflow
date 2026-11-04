-- Adds the capture mode of a payment intent and the statuses of a manual
-- capture (P-08).
--
-- capture_mode is chosen when the intent is created and never changes:
-- AUTOMATIC authorizes and captures in one step (the behavior of every intent
-- created before this migration), and MANUAL only authorizes, after which the
-- merchant captures or voids the hold. The default is AUTOMATIC, the default
-- mode of the API, so every existing row gets it; the application always
-- writes the value explicitly.
--
-- REQUIRES_CAPTURE: a MANUAL payment was authorized and its funds are held,
-- not captured. CANCELED: that hold was voided and nothing was captured. The
-- status list mirrors PAYMENT_INTENT_STATUSES in packages/domain.

ALTER TABLE payment_intents
  ADD COLUMN capture_mode varchar(16) NOT NULL DEFAULT 'AUTOMATIC',
  ADD CONSTRAINT payment_intents_capture_mode_check CHECK (
    capture_mode IN ('AUTOMATIC', 'MANUAL')
  ),
  DROP CONSTRAINT payment_intents_status_check,
  ADD CONSTRAINT payment_intents_status_check CHECK (
    status IN (
      'CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REQUIRES_ACTION',
      'PARTIALLY_REFUNDED', 'REFUNDED', 'REQUIRES_CAPTURE', 'CANCELED'
    )
  );

COMMENT ON COLUMN payment_intents.capture_mode IS 'AUTOMATIC captures a successful payment at once; MANUAL only authorizes it, and the merchant captures or voids the hold. Never changes.';

-- What an intent is (its merchant, amount, currency, reference, capture mode,
-- identity, and creation time) never changes; only its status and updated_at
-- move. Replaces the function of 20261103230000 with the capture mode added.
CREATE OR REPLACE FUNCTION payment_intents_reject_invalid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.amount_minor, NEW.currency,
      NEW.merchant_reference, NEW.capture_mode, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.amount_minor, OLD.currency,
      OLD.merchant_reference, OLD.capture_mode, OLD.created_at) THEN
    RAISE EXCEPTION 'payment_intents: only status and updated_at can be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
