CREATE TABLE build_snapshots (
  id INTEGER PRIMARY KEY,
  pending_id TEXT UNIQUE,
  build_id TEXT UNIQUE,
  blueprint_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  flow_json TEXT NOT NULL,
  svg TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (pending_id IS NOT NULL OR build_id IS NOT NULL)
);

CREATE TRIGGER build_snapshots_build_id_set_once BEFORE UPDATE ON build_snapshots
WHEN NOT (
  OLD.build_id IS NULL AND NEW.build_id IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.pending_id IS OLD.pending_id
  AND NEW.blueprint_name IS OLD.blueprint_name AND NEW.version IS OLD.version
  AND NEW.flow_json IS OLD.flow_json AND NEW.svg IS OLD.svg
  AND NEW.created_at IS OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'build snapshots are locked');
END;

CREATE TRIGGER build_snapshots_no_delete BEFORE DELETE ON build_snapshots
BEGIN
  SELECT RAISE(ABORT, 'build snapshots are locked');
END;

CREATE TRIGGER build_snapshots_no_replace BEFORE INSERT ON build_snapshots
WHEN EXISTS (
  SELECT 1 FROM build_snapshots WHERE pending_id = NEW.pending_id OR build_id = NEW.build_id)
BEGIN
  SELECT RAISE(ABORT, 'build snapshots are locked');
END;

DROP TRIGGER builds_from_saved_version;
