-- Adds the index behind keyset pagination of GET /api/v1/payment-intents.
--
-- The list filters by merchant_id, orders by (created_at, id) descending, and
-- continues after the last row of the previous page with a row comparison on
-- the same two columns. One btree on (merchant_id, created_at, id), scanned
-- backwards, serves the filter, the ordering, and the continuation without a
-- sort. id breaks ties between intents created at the same instant, which
-- makes the order total and therefore stable.
--
-- status is not a column of the index: the optional status filter is checked
-- on the rows the scan reaches. Leaving it out keeps every indexed column of
-- the table immutable, so a status change can stay a heap-only (HOT) update
-- that writes no index entry when the page has room.

CREATE INDEX payment_intents_merchant_id_created_at_id_idx ON payment_intents (merchant_id, created_at, id);
