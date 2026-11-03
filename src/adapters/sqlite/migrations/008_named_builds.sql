-- flowdeck:no-transaction
DROP TRIGGER builds_from_saved_version;
DROP TRIGGER builds_no_replace;
DROP TRIGGER builds_no_update;
DROP TRIGGER builds_no_delete;
DROP TRIGGER build_files_no_insert;
DROP TRIGGER build_files_no_update;
DROP TRIGGER build_files_no_delete;
DROP TRIGGER build_nodes_no_insert;
DROP TRIGGER build_nodes_no_update;
DROP TRIGGER build_nodes_no_delete;
DROP TRIGGER runs_name_their_build;
DROP TRIGGER runs_no_replace;
DROP TRIGGER runs_build_locked;
DROP TRIGGER run_nodes_in_build;

CREATE TABLE builds_new (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  name TEXT,
  repo TEXT,
  base TEXT,
  "values" TEXT,
  deleted_at INTEGER,
  dir TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  flow_id TEXT,
  version INTEGER
);

INSERT INTO builds_new (rowid, id, hash, dir, created_at, flow_id, version)
  SELECT rowid, hash, hash, dir, created_at, flow_id, version FROM builds;

CREATE TABLE build_files_new (
  build_id TEXT NOT NULL REFERENCES builds(id) DEFERRABLE INITIALLY DEFERRED,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (build_id, path)
);

INSERT INTO build_files_new (build_id, path, sha256)
  SELECT build_hash, path, sha256 FROM build_files;

CREATE TABLE build_nodes_new (
  build_id TEXT NOT NULL REFERENCES builds(id) DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  file TEXT,
  PRIMARY KEY (build_id, node_id),
  FOREIGN KEY (build_id, file) REFERENCES build_files(build_id, path) DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO build_nodes_new (build_id, ordinal, node_id, type, config, file)
  SELECT build_hash, ordinal, node_id, type, config, file FROM build_nodes;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  build_dir TEXT NOT NULL,
  inputs TEXT NOT NULL,
  status TEXT NOT NULL,
  total_cost REAL,
  created_at TEXT NOT NULL,
  build_id TEXT REFERENCES builds(id)
);

INSERT INTO runs_new (rowid, id, build_dir, inputs, status, total_cost, created_at, build_id)
  SELECT rowid, id, build_dir, inputs, status, total_cost, created_at, build_hash FROM runs;

DROP TABLE build_nodes;
DROP TABLE build_files;
DROP TABLE runs;
DROP TABLE builds;

ALTER TABLE builds_new RENAME TO builds;
ALTER TABLE build_files_new RENAME TO build_files;
ALTER TABLE build_nodes_new RENAME TO build_nodes;
ALTER TABLE runs_new RENAME TO runs;

CREATE UNIQUE INDEX builds_live_name ON builds (name) WHERE deleted_at IS NULL;

CREATE TRIGGER builds_from_saved_version BEFORE INSERT ON builds
WHEN (NEW.flow_id IS NULL) <> (NEW.version IS NULL)
  OR (NEW.flow_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM flow_versions WHERE flow_id = NEW.flow_id AND version = NEW.version))
BEGIN
  SELECT RAISE(ABORT, 'a build names a saved flow version, or none');
END;

CREATE TRIGGER builds_no_replace BEFORE INSERT ON builds
WHEN EXISTS (SELECT 1 FROM builds WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER builds_only_deleted_once BEFORE UPDATE ON builds
WHEN NOT (
  OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.hash IS OLD.hash AND NEW.name IS OLD.name
  AND NEW.repo IS OLD.repo AND NEW.base IS OLD.base AND NEW."values" IS OLD."values"
  AND NEW.dir IS OLD.dir AND NEW.created_at IS OLD.created_at
  AND NEW.flow_id IS OLD.flow_id AND NEW.version IS OLD.version)
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER builds_no_delete BEFORE DELETE ON builds
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER build_files_no_insert BEFORE INSERT ON build_files
WHEN EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id)
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER build_files_no_update BEFORE UPDATE ON build_files
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER build_files_no_delete BEFORE DELETE ON build_files
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER build_nodes_no_insert BEFORE INSERT ON build_nodes
WHEN EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id)
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER build_nodes_no_update BEFORE UPDATE ON build_nodes
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER build_nodes_no_delete BEFORE DELETE ON build_nodes
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER runs_name_their_build BEFORE INSERT ON runs
WHEN NEW.build_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a run names the build it runs');
END;

CREATE TRIGGER runs_no_replace BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM runs WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a run is never replaced');
END;

CREATE TRIGGER runs_build_locked BEFORE UPDATE OF build_id, build_dir ON runs
BEGIN
  SELECT RAISE(ABORT, 'the build a run names is locked');
END;

CREATE TRIGGER runs_of_live_builds BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'build is deleted');
END;

CREATE TRIGGER runs_one_running_on_insert BEFORE INSERT ON runs
WHEN NEW.status = 'running'
  AND EXISTS (SELECT 1 FROM runs WHERE build_id = NEW.build_id AND status = 'running')
BEGIN
  SELECT RAISE(ABORT, 'build is running');
END;

CREATE TRIGGER runs_one_running_on_update BEFORE UPDATE OF status ON runs
WHEN NEW.status = 'running' AND OLD.status <> 'running'
  AND EXISTS (
    SELECT 1 FROM runs WHERE build_id = NEW.build_id AND status = 'running' AND id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'build is running');
END;

CREATE TRIGGER run_nodes_in_build BEFORE INSERT ON run_nodes
WHEN EXISTS (
    SELECT 1 FROM runs JOIN build_nodes ON build_nodes.build_id = runs.build_id
     WHERE runs.id = NEW.run_id)
  AND NOT EXISTS (
    SELECT 1 FROM runs JOIN build_nodes ON build_nodes.build_id = runs.build_id
     WHERE runs.id = NEW.run_id AND build_nodes.node_id = NEW.node_id)
BEGIN
  SELECT RAISE(ABORT, 'a run node is a node of its build');
END;
