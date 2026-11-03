-- Adds the index behind keyset pagination of GET /api/v1/merchants.
--
-- The listing orders by (created_at, id) and continues after the last row of
-- the previous page with a row comparison on the same two columns, so one
-- btree on exactly those columns, in that order, serves both the ordering and
-- the continuation without a sort. id breaks ties between merchants created at
-- the same instant, which makes the order total and therefore stable.

CREATE INDEX merchants_created_at_id_idx ON merchants (created_at, id);
