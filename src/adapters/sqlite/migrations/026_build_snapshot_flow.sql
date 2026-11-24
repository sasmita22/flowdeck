ALTER TABLE build_snapshots ADD COLUMN flow_json TEXT;

DROP TRIGGER build_snapshots_build_id_set_once;

CREATE TRIGGER build_snapshots_build_id_set_once BEFORE UPDATE ON build_snapshots
WHEN NOT (
  OLD.build_id IS NULL AND NEW.build_id IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.pending_id IS OLD.pending_id
  AND NEW.blueprint_name IS OLD.blueprint_name AND NEW.version IS OLD.version
  AND NEW.svg IS OLD.svg AND NEW.flow_json IS OLD.flow_json
  AND NEW.created_at IS OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'build snapshots are locked');
END;
