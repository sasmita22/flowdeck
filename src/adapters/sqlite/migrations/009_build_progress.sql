CREATE TABLE pending_builds (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('built', 'needs-you', 'failed', 'stopped')),
  build_id TEXT,
  report_json TEXT
);

CREATE UNIQUE INDEX pending_builds_one_per_flow ON pending_builds (flow_id) WHERE ended_at IS NULL;

CREATE UNIQUE INDEX pending_builds_one_per_name ON pending_builds (name) WHERE ended_at IS NULL;

CREATE TRIGGER pending_builds_end_set_once BEFORE UPDATE ON pending_builds
WHEN (OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at)
  OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
  OR (OLD.build_id IS NOT NULL AND NEW.build_id IS NOT OLD.build_id)
  OR (OLD.report_json IS NOT NULL AND NEW.report_json IS NOT OLD.report_json)
BEGIN
  SELECT RAISE(ABORT, 'a pending build''s end is set once');
END;

CREATE TABLE build_events (
  pending_id TEXT NOT NULL REFERENCES pending_builds(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (pending_id, seq)
);

CREATE TRIGGER build_events_no_update BEFORE UPDATE ON build_events
BEGIN
  SELECT RAISE(ABORT, 'build events are append-only');
END;

CREATE TRIGGER build_events_no_delete BEFORE DELETE ON build_events
BEGIN
  SELECT RAISE(ABORT, 'build events are append-only');
END;

CREATE TRIGGER build_events_no_replace BEFORE INSERT ON build_events
WHEN EXISTS (SELECT 1 FROM build_events WHERE pending_id = NEW.pending_id AND seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'build events are append-only');
END;

CREATE TABLE build_activity (
  pending_id TEXT NOT NULL REFERENCES pending_builds(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (pending_id, seq)
);

CREATE TRIGGER build_activity_no_update BEFORE UPDATE ON build_activity
BEGIN
  SELECT RAISE(ABORT, 'build activity is append-only');
END;

CREATE TRIGGER build_activity_no_delete BEFORE DELETE ON build_activity
BEGIN
  SELECT RAISE(ABORT, 'build activity is append-only');
END;

CREATE TRIGGER build_activity_no_replace BEFORE INSERT ON build_activity
WHEN EXISTS (SELECT 1 FROM build_activity WHERE pending_id = NEW.pending_id AND seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'build activity is append-only');
END;
