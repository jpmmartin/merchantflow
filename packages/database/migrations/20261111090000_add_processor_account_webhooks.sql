-- Adds the webhook configuration of a processor account: the signing secret
-- the provider signs its events with, encrypted with AES-256-GCM under the
-- credentials master key and bound to its row (the same cipher as the secret
-- key, with its own associated data), the last four characters of the secret
-- as a hint, how the webhook was configured, the provider's ID of the endpoint
-- when the platform created it, and when it was configured. The columns are
-- all set or all empty: an account has a webhook configuration or none.

ALTER TABLE processor_accounts
  ADD COLUMN webhook_secret_ciphertext bytea,
  ADD COLUMN webhook_secret_iv bytea,
  ADD COLUMN webhook_secret_auth_tag bytea,
  ADD COLUMN webhook_secret_version integer,
  ADD COLUMN webhook_secret_hint varchar(4),
  -- AUTOMATIC: the platform created the endpoint at the provider with the
  -- account's secret key. MANUAL: the merchant created it and pasted its
  -- signing secret.
  ADD COLUMN webhook_mode varchar(10),
  -- The provider's endpoint, such as a Stripe `we_` ID; only for AUTOMATIC,
  -- whose endpoint the platform deletes when the configuration is replaced or
  -- removed.
  ADD COLUMN webhook_endpoint_id varchar(255),
  ADD COLUMN webhook_configured_at timestamptz,
  ADD CONSTRAINT processor_accounts_webhook_mode_check CHECK (
    webhook_mode IN ('AUTOMATIC', 'MANUAL')
  ),
  ADD CONSTRAINT processor_accounts_webhook_secret_iv_check CHECK (
    octet_length(webhook_secret_iv) = 12
  ),
  ADD CONSTRAINT processor_accounts_webhook_secret_auth_tag_check CHECK (
    octet_length(webhook_secret_auth_tag) = 16
  ),
  ADD CONSTRAINT processor_accounts_webhook_secret_ciphertext_check CHECK (
    octet_length(webhook_secret_ciphertext) > 0
  ),
  ADD CONSTRAINT processor_accounts_webhook_secret_version_check CHECK (
    webhook_secret_version >= 1
  ),
  ADD CONSTRAINT processor_accounts_webhook_secret_hint_check CHECK (
    char_length(webhook_secret_hint) = 4
  ),
  ADD CONSTRAINT processor_accounts_webhook_endpoint_id_check CHECK (
    webhook_endpoint_id ~ '^[A-Za-z0-9_]{1,255}$'
  ),
  -- Every part of the configuration is present, or none is.
  ADD CONSTRAINT processor_accounts_webhook_complete_check CHECK (
    (webhook_mode IS NULL) = (webhook_secret_ciphertext IS NULL)
    AND (webhook_mode IS NULL) = (webhook_secret_iv IS NULL)
    AND (webhook_mode IS NULL) = (webhook_secret_auth_tag IS NULL)
    AND (webhook_mode IS NULL) = (webhook_secret_version IS NULL)
    AND (webhook_mode IS NULL) = (webhook_secret_hint IS NULL)
    AND (webhook_mode IS NULL) = (webhook_configured_at IS NULL)
  ),
  -- Only an endpoint the platform created has a provider endpoint ID.
  ADD CONSTRAINT processor_accounts_webhook_endpoint_mode_check CHECK (
    (webhook_mode = 'AUTOMATIC' AND webhook_endpoint_id IS NOT NULL)
    OR (webhook_mode = 'MANUAL' AND webhook_endpoint_id IS NULL)
    OR (webhook_mode IS NULL AND webhook_endpoint_id IS NULL)
  );
