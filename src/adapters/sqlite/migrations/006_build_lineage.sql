ALTER TABLE builds ADD COLUMN flow_id TEXT;
ALTER TABLE builds ADD COLUMN version INTEGER;

CREATE TABLE build_files (
  build_hash TEXT NOT NULL REFERENCES builds(hash) DEFERRABLE INITIALLY DEFERRED,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (build_hash, path)
);

CREATE TABLE build_nodes (
  build_hash TEXT NOT NULL REFERENCES builds(hash) DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  file TEXT,
  PRIMARY KEY (build_hash, node_id),
  FOREIGN KEY (build_hash, file) REFERENCES build_files(build_hash, path) DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER builds_from_saved_version BEFORE INSERT ON builds
WHEN (NEW.flow_id IS NULL) <> (NEW.version IS NULL)
  OR (NEW.flow_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM flow_versions WHERE flow_id = NEW.flow_id AND version = NEW.version))
BEGIN
  SELECT RAISE(ABORT, 'a build names a saved flow version, or none');
END;

CREATE TRIGGER builds_no_replace BEFORE INSERT ON builds
WHEN EXISTS (SELECT 1 FROM builds WHERE hash = NEW.hash)
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER builds_no_update BEFORE UPDATE ON builds
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER builds_no_delete BEFORE DELETE ON builds
BEGIN
  SELECT RAISE(ABORT, 'builds are locked');
END;

CREATE TRIGGER build_files_no_insert BEFORE INSERT ON build_files
WHEN EXISTS (SELECT 1 FROM builds WHERE hash = NEW.build_hash)
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
WHEN EXISTS (SELECT 1 FROM builds WHERE hash = NEW.build_hash)
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
WHEN NEW.build_hash IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a run names the build it runs');
END;

CREATE TRIGGER runs_no_replace BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM runs WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a run is never replaced');
END;

CREATE TRIGGER runs_build_locked BEFORE UPDATE OF build_hash, build_dir ON runs
BEGIN
  SELECT RAISE(ABORT, 'the build a run names is locked');
END;

CREATE TRIGGER run_nodes_in_build BEFORE INSERT ON run_nodes
WHEN EXISTS (
    SELECT 1 FROM runs JOIN build_nodes ON build_nodes.build_hash = runs.build_hash
     WHERE runs.id = NEW.run_id)
  AND NOT EXISTS (
    SELECT 1 FROM runs JOIN build_nodes ON build_nodes.build_hash = runs.build_hash
     WHERE runs.id = NEW.run_id AND build_nodes.node_id = NEW.node_id)
BEGIN
  SELECT RAISE(ABORT, 'a run node is a node of its build');
END;
