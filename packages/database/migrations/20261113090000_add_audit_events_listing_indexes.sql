-- Adds the indexes behind GET /api/v1/audit-events and the audit part of
-- GET /api/v1/payment-intents/:id/timeline. Until now audit_events had only
-- its primary key.
--
-- The list is ordered by (occurred_at, id) descending and continues after the
-- last row of the previous page with a row comparison on the same two columns.
-- A merchant user's list also filters by merchant_id, so it is served by a
-- btree on (merchant_id, occurred_at, id) scanned backwards; the platform
-- administrator's list, which has no merchant filter, by one on
-- (occurred_at, id). id breaks ties between events of the same instant, which
-- makes the order total and therefore stable. A date range narrows the same
-- scans on occurred_at.
--
-- The optional action filter is checked on the rows the scan reaches, as the
-- status filter of the payment intent list is: listing a rare action among
-- very many events is not a need of the demo.
--
-- The timeline reads the events whose target is one payment intent, so a
-- btree on (target_type, target_id, occurred_at, id) finds them without
-- scanning the merchant's events and returns them in time order. Every column
-- of the table is immutable (append-only trigger), so the indexes never need
-- updating after an insert.

CREATE INDEX audit_events_merchant_id_occurred_at_id_idx ON audit_events (merchant_id, occurred_at, id);

CREATE INDEX audit_events_occurred_at_id_idx ON audit_events (occurred_at, id);

CREATE INDEX audit_events_target_type_target_id_occurred_at_id_idx ON audit_events (target_type, target_id, occurred_at, id);
