ALTER TABLE runs ADD COLUMN number INTEGER;

UPDATE runs SET number = (
  SELECT numbered.number
    FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY build_id ORDER BY rowid) AS number
            FROM runs) AS numbered
   WHERE numbered.id = runs.id);

CREATE TABLE run_number_counters (
  build_id TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

INSERT INTO run_number_counters (build_id, last)
  SELECT build_id, MAX(number) FROM runs WHERE build_id IS NOT NULL GROUP BY build_id;

ALTER TABLE run_repo_states ADD COLUMN repo TEXT;

CREATE TABLE build_step_texts (
  id INTEGER PRIMARY KEY,
  pending_id TEXT NOT NULL REFERENCES pending_builds(id),
  entry_id INTEGER NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('input', 'output', 'report')),
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX build_step_texts_by_entry ON build_step_texts (pending_id, entry_id);

CREATE TRIGGER build_step_texts_no_update BEFORE UPDATE ON build_step_texts
BEGIN
  SELECT RAISE(ABORT, 'build step texts are append-only');
END;

CREATE TRIGGER build_step_texts_no_replace BEFORE INSERT ON build_step_texts
WHEN EXISTS (SELECT 1 FROM build_step_texts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'build step texts are append-only');
END;

DROP TRIGGER events_no_delete;
DROP TRIGGER activity_no_delete;
DROP TRIGGER run_stories_no_delete;
DROP TRIGGER run_repo_states_no_delete;
DROP TRIGGER step_texts_no_delete;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = OLD.run_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = OLD.run_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'activity is append-only');
END;

CREATE TRIGGER run_stories_no_delete BEFORE DELETE ON run_stories
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = OLD.run_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'run stories are append-only');
END;

CREATE TRIGGER run_repo_states_no_delete BEFORE DELETE ON run_repo_states
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = OLD.run_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'run repo states are append-only');
END;

CREATE TRIGGER step_texts_no_delete BEFORE DELETE ON step_texts
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = OLD.run_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'step texts are append-only');
END;

CREATE TEMP TABLE deleted_runs AS SELECT id FROM runs WHERE deleted_at IS NOT NULL;

DELETE FROM step_texts WHERE run_id IN (SELECT id FROM deleted_runs);
DELETE FROM run_repo_states WHERE run_id IN (SELECT id FROM deleted_runs);
DELETE FROM run_stories WHERE run_id IN (SELECT id FROM deleted_runs);
DELETE FROM activity WHERE run_id IN (SELECT id FROM deleted_runs);
DELETE FROM events WHERE run_id IN (SELECT id FROM deleted_runs);
DELETE FROM run_nodes WHERE run_id IN (SELECT id FROM deleted_runs);
DELETE FROM run_sessions WHERE run_id IN (SELECT id FROM deleted_runs);
DELETE FROM runs WHERE id IN (SELECT id FROM deleted_runs);

DROP TABLE deleted_runs;

CREATE TEMP TABLE deleted_pending_builds AS
  SELECT gone.id FROM pending_builds AS gone WHERE gone.deleted_at IS NOT NULL
  UNION
  SELECT older.id FROM pending_builds AS older
    JOIN pending_builds AS gone ON gone.name = older.name AND gone.id <> older.id
   WHERE gone.deleted_at IS NOT NULL
     AND older.build_id IS NULL AND older.ended_at IS NOT NULL
     AND (older.started_at < gone.started_at
       OR (older.started_at = gone.started_at AND older.rowid < gone.rowid));

DELETE FROM build_activity WHERE pending_id IN (SELECT id FROM deleted_pending_builds);
DELETE FROM build_events WHERE pending_id IN (SELECT id FROM deleted_pending_builds);
DELETE FROM build_snapshots
 WHERE pending_id IN (SELECT id FROM deleted_pending_builds) AND build_id IS NULL;
DELETE FROM build_step_texts WHERE pending_id IN (SELECT id FROM deleted_pending_builds);
DELETE FROM pending_builds WHERE id IN (SELECT id FROM deleted_pending_builds);

DROP TABLE deleted_pending_builds;

PRAGMA foreign_key_check;
