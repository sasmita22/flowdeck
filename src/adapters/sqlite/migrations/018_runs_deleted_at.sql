ALTER TABLE runs ADD COLUMN deleted_at INTEGER;
ALTER TABLE pending_builds ADD COLUMN deleted_at INTEGER;

CREATE TRIGGER runs_only_deleted_once BEFORE UPDATE OF deleted_at ON runs
WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a run is deleted once');
END;

CREATE TRIGGER pending_builds_only_deleted_once BEFORE UPDATE OF deleted_at ON pending_builds
WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a pending build is deleted once');
END;
