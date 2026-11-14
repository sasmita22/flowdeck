ALTER TABLE flows ADD COLUMN deleted_at INTEGER;

CREATE TRIGGER flows_deleted_at_set_once BEFORE UPDATE OF deleted_at ON flows
WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a blueprint is deleted once');
END;
