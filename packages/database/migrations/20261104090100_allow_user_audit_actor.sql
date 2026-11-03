-- Adds USER as an audit actor type, so an action taken by a signed-in user
-- records the user. The check is replaced in one statement; the existing rows
-- all satisfy the new list.

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_actor_type_check,
  ADD CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN ('API_KEY', 'SYSTEM', 'USER'));
