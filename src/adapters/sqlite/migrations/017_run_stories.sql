CREATE TABLE run_stories (
  seq INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL,
  run_status TEXT NOT NULL,
  text TEXT NOT NULL,
  cost REAL NOT NULL
);

CREATE INDEX run_stories_by_run ON run_stories (run_id, seq);

CREATE TRIGGER run_stories_no_update BEFORE UPDATE ON run_stories
BEGIN
  SELECT RAISE(ABORT, 'run stories are append-only');
END;

CREATE TRIGGER run_stories_no_delete BEFORE DELETE ON run_stories
BEGIN
  SELECT RAISE(ABORT, 'run stories are append-only');
END;

CREATE TRIGGER run_stories_no_replace BEFORE INSERT ON run_stories
WHEN EXISTS (SELECT 1 FROM run_stories WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'run stories are append-only');
END;
