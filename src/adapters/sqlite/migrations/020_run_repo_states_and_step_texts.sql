CREATE TABLE run_repo_states (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('before', 'after')),
  state_json TEXT NOT NULL,
  other_repos_json TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX run_repo_states_by_run ON run_repo_states (run_id);

CREATE TRIGGER run_repo_states_no_update BEFORE UPDATE ON run_repo_states
BEGIN
  SELECT RAISE(ABORT, 'run repo states are append-only');
END;

CREATE TRIGGER run_repo_states_no_delete BEFORE DELETE ON run_repo_states
BEGIN
  SELECT RAISE(ABORT, 'run repo states are append-only');
END;

CREATE TRIGGER run_repo_states_no_replace BEFORE INSERT ON run_repo_states
WHEN EXISTS (SELECT 1 FROM run_repo_states WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'run repo states are append-only');
END;

CREATE TABLE step_texts (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  entry_id INTEGER NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('input', 'output', 'report')),
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX step_texts_by_entry ON step_texts (run_id, entry_id);

CREATE TRIGGER step_texts_no_update BEFORE UPDATE ON step_texts
BEGIN
  SELECT RAISE(ABORT, 'step texts are append-only');
END;

CREATE TRIGGER step_texts_no_delete BEFORE DELETE ON step_texts
BEGIN
  SELECT RAISE(ABORT, 'step texts are append-only');
END;

CREATE TRIGGER step_texts_no_replace BEFORE INSERT ON step_texts
WHEN EXISTS (SELECT 1 FROM step_texts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'step texts are append-only');
END;
