DROP TRIGGER builds_only_deleted_once;

ALTER TABLE builds ADD COLUMN branch TEXT;
ALTER TABLE builds ADD COLUMN branch_created INTEGER;

UPDATE builds
   SET branch = 'flowdeck/' || name || '-' || substr(id, 1, 8), branch_created = 1
 WHERE name IS NOT NULL;

CREATE TRIGGER builds_only_deleted_once BEFORE UPDATE ON builds
WHEN NOT (
  OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.hash IS OLD.hash AND NEW.name IS OLD.name
  AND NEW.repo IS OLD.repo AND NEW.base IS OLD.base AND NEW."values" IS OLD."values"
  AND NEW.dir IS OLD.dir AND NEW.created_at IS OLD.created_at
  AND NEW.flow_id IS OLD.flow_id AND NEW.version IS OLD.version
  AND NEW.branch IS OLD.branch AND NEW.branch_created IS OLD.branch_created)
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;
