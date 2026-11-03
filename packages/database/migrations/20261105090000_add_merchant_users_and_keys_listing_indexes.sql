-- Adds the indexes behind the lists of a merchant's users and API keys
-- (GET /api/v1/merchants/{id}/users and GET /api/v1/merchants/{id}/api-keys).
--
-- Each list filters by merchant_id and orders by (created_at, id), so one btree
-- on exactly those columns, in that order, serves both the filter and the
-- ordering without a sort. Platform rows have no merchant_id and are never
-- listed through a merchant.

CREATE INDEX users_merchant_id_created_at_id_idx ON users (merchant_id, created_at, id);

CREATE INDEX api_keys_merchant_id_created_at_id_idx ON api_keys (merchant_id, created_at, id);
