-- The inbox of provider events received on a processor account's webhook,
-- owned by the webhooks module. One row per delivery identity: the account and
-- the provider's event ID. An event is stored after its signature is verified
-- and before it is processed; its outcome is recorded once processing ends.
-- PROCESSED and IGNORED are final, so a redelivery of such an event changes
-- nothing; a FAILED event is processed again when the provider redelivers it.
-- No secret, signature, or payload is stored.

CREATE TABLE processor_events (
  id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  processor_account_id uuid NOT NULL,
  -- The provider's event ID, such as a Stripe `evt_` ID.
  provider_event_id varchar(255) NOT NULL,
  -- The provider's event type, such as `refund.updated`.
  event_type varchar(100) NOT NULL,
  -- The type and ID of the object the event is about, such as `refund` and a
  -- `re_` ID, when the event names one.
  object_type varchar(50),
  object_id varchar(255),
  received_at timestamptz NOT NULL,
  -- How many times processing ran, redeliveries included.
  attempts integer NOT NULL,
  -- NULL until processing ends for the first time.
  outcome varchar(20),
  -- A short code of what processing did or why it failed, such as
  -- REFUND_SUCCEEDED or LOOKUP_UNAVAILABLE.
  detail varchar(64),
  -- When processing last ended, whatever its outcome.
  processed_at timestamptz,
  CONSTRAINT processor_events_pkey PRIMARY KEY (id),
  CONSTRAINT processor_events_delivery_key UNIQUE (processor_account_id, provider_event_id),
  CONSTRAINT processor_events_processor_account_fkey FOREIGN KEY (merchant_id, processor_account_id)
    REFERENCES processor_accounts (merchant_id, id),
  CONSTRAINT processor_events_provider_event_id_check CHECK (provider_event_id ~ '^[A-Za-z0-9_]{1,255}$'),
  CONSTRAINT processor_events_event_type_check CHECK (event_type ~ '^[a-z0-9_.]{1,100}$'),
  CONSTRAINT processor_events_object_type_check CHECK (object_type ~ '^[a-z0-9_.]{1,50}$'),
  CONSTRAINT processor_events_object_id_check CHECK (object_id ~ '^[A-Za-z0-9_]{1,255}$'),
  CONSTRAINT processor_events_attempts_check CHECK (attempts >= 0),
  CONSTRAINT processor_events_outcome_check CHECK (
    outcome IN ('PROCESSED', 'IGNORED', 'FAILED')
  ),
  CONSTRAINT processor_events_detail_check CHECK (detail ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  -- An outcome is recorded with its time and its detail, and only after at
  -- least one processing run.
  CONSTRAINT processor_events_outcome_consistency_check CHECK (
    (outcome IS NULL) = (processed_at IS NULL)
    AND (outcome IS NULL) = (detail IS NULL)
    AND (outcome IS NULL OR attempts >= 1)
  )
);

CREATE INDEX processor_events_account_received_at_idx
  ON processor_events (merchant_id, processor_account_id, received_at, id);

COMMENT ON TABLE processor_events IS 'Inbox of verified provider webhook events, unique per account and provider event ID. No secret or payload is stored.';

-- What an event is never changes, and a final outcome (PROCESSED or IGNORED)
-- is never replaced.
CREATE FUNCTION processor_events_reject_invalid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.processor_account_id, NEW.provider_event_id,
      NEW.event_type, NEW.object_type, NEW.object_id, NEW.received_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.processor_account_id, OLD.provider_event_id,
      OLD.event_type, OLD.object_type, OLD.object_id, OLD.received_at) THEN
    RAISE EXCEPTION 'processor_events: the identity of an event cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.outcome IN ('PROCESSED', 'IGNORED') THEN
    RAISE EXCEPTION 'processor_events: a processed event cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'processor_events: the attempt count cannot decrease'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER processor_events_restrict_update
BEFORE UPDATE ON processor_events
FOR EACH ROW
EXECUTE FUNCTION processor_events_reject_invalid_update();

-- The inbox is the history of what the provider reported, so rows are never
-- deleted.
CREATE FUNCTION processor_events_reject_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'processor_events: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER processor_events_restrict_delete
BEFORE DELETE OR TRUNCATE ON processor_events
FOR EACH STATEMENT
EXECUTE FUNCTION processor_events_reject_delete();
