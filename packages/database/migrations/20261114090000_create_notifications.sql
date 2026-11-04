-- The notifications of payment and refund changes that happen without a
-- request of the user (P-11), owned by the notifications module, and the read
-- state of each user. A notification is written in the transaction of the
-- change it reports, together with a NOTIFY that carries only its ID, so
-- nothing is delivered for a change that rolls back. No secret, token,
-- provider payload, or card data is stored.

-- The read state names a user of the notification's merchant. The composite
-- key makes a read of another merchant's notification impossible.
ALTER TABLE users
  ADD CONSTRAINT users_merchant_id_id_key UNIQUE (merchant_id, id);

CREATE TABLE notifications (
  id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  type varchar(40) NOT NULL,
  payment_intent_id uuid NOT NULL,
  -- The refund the change is about, for the refund types only.
  refund_id uuid,
  -- The amount the change is about (the refund, or the payment) and its
  -- currency, in minor units.
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  -- A short text built only from the type and the merchant's own order
  -- reference.
  summary varchar(200) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_merchant_id_id_key UNIQUE (merchant_id, id),
  CONSTRAINT notifications_payment_intent_fkey FOREIGN KEY (merchant_id, payment_intent_id)
    REFERENCES payment_intents (merchant_id, id),
  CONSTRAINT notifications_refund_fkey FOREIGN KEY (merchant_id, refund_id)
    REFERENCES refunds (merchant_id, id),
  CONSTRAINT notifications_type_check CHECK (
    type IN (
      'REFUND_SUCCEEDED',
      'REFUND_FAILED',
      'REFUND_REVERSED',
      'REFUND_PENDING',
      'PAYMENT_SUCCEEDED',
      'PAYMENT_AUTHORIZED',
      'PAYMENT_UNSUCCESSFUL',
      'CAPTURE_SUCCEEDED',
      'CAPTURE_FAILED',
      'VOID_SUCCEEDED',
      'VOID_FAILED'
    )
  ),
  -- A refund type names its refund, and no other type names one.
  CONSTRAINT notifications_refund_check CHECK (
    (type LIKE 'REFUND\_%') = (refund_id IS NOT NULL)
  ),
  CONSTRAINT notifications_amount_minor_check CHECK (amount_minor > 0),
  CONSTRAINT notifications_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT notifications_summary_check CHECK (
    length(summary) BETWEEN 1 AND 200 AND summary !~ '^\s|\s$'
  )
);

-- The tray (newest first) and the refill after a position (oldest first).
CREATE INDEX notifications_merchant_id_created_at_id_idx
  ON notifications (merchant_id, created_at, id);

COMMENT ON TABLE notifications IS 'Payment and refund changes made without a request of the user, per merchant. No secret or provider payload is stored.';

-- A notification reports a change that happened, so it never changes and is
-- never deleted.
CREATE FUNCTION notifications_reject_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'notifications: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER notifications_restrict_update
BEFORE UPDATE ON notifications
FOR EACH ROW
EXECUTE FUNCTION notifications_reject_change();

CREATE TRIGGER notifications_restrict_delete
BEFORE DELETE OR TRUNCATE ON notifications
FOR EACH STATEMENT
EXECUTE FUNCTION notifications_reject_change();

-- One row per notification a user has read. A notification with no row for a
-- user is unread for that user.
CREATE TABLE notification_reads (
  merchant_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL,
  CONSTRAINT notification_reads_pkey PRIMARY KEY (notification_id, user_id),
  CONSTRAINT notification_reads_notification_fkey FOREIGN KEY (merchant_id, notification_id)
    REFERENCES notifications (merchant_id, id),
  CONSTRAINT notification_reads_user_fkey FOREIGN KEY (merchant_id, user_id)
    REFERENCES users (merchant_id, id)
);

COMMENT ON TABLE notification_reads IS 'Which user of the merchant has read which notification, and when.';

-- Reading a notification is recorded once and never undone.
CREATE FUNCTION notification_reads_reject_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'notification_reads: a read cannot be changed'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER notification_reads_restrict_update
BEFORE UPDATE ON notification_reads
FOR EACH ROW
EXECUTE FUNCTION notification_reads_reject_update();
