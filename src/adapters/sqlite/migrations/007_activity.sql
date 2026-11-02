CREATE TABLE activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  entry TEXT NOT NULL
);

CREATE INDEX activity_by_entry ON activity (run_id, id, seq);

CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity
BEGIN
  SELECT RAISE(ABORT, 'activity is append-only');
END;

CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity
BEGIN
  SELECT RAISE(ABORT, 'activity is append-only');
END;

CREATE TRIGGER activity_no_replace BEFORE INSERT ON activity
WHEN EXISTS (SELECT 1 FROM activity WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'activity is append-only');
END;
