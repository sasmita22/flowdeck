CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  build_dir TEXT NOT NULL,
  inputs TEXT NOT NULL,
  status TEXT NOT NULL,
  total_cost REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE run_sessions (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tmux_name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  parent INTEGER REFERENCES run_sessions(id)
);

CREATE TABLE run_nodes (
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES run_sessions(id),
  started_at TEXT,
  finished_at TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  tokens INTEGER,
  cost REAL,
  time TEXT NOT NULL,
  FOREIGN KEY (run_id, node_id) REFERENCES run_nodes(run_id, node_id)
);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
