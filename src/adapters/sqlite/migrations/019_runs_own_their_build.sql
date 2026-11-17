-- flowdeck:no-transaction
DROP TRIGGER builds_no_delete;
DROP TRIGGER build_files_no_delete;
DROP TRIGGER build_nodes_no_delete;
DROP TRIGGER build_snapshots_no_delete;
DROP TRIGGER build_manifests_no_delete;
DROP TRIGGER build_events_no_delete;
DROP TRIGGER build_activity_no_delete;
DROP TRIGGER runs_name_their_build;
DROP TRIGGER runs_no_replace;
DROP TRIGGER runs_build_locked;
DROP TRIGGER runs_of_live_builds;
DROP TRIGGER runs_one_running_on_insert;
DROP TRIGGER runs_one_running_on_update;
DROP TRIGGER runs_only_deleted_once;
DROP TRIGGER run_nodes_in_build;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  build_dir TEXT NOT NULL,
  inputs TEXT NOT NULL,
  status TEXT NOT NULL,
  total_cost REAL,
  created_at TEXT NOT NULL,
  build_id TEXT,
  deleted_at INTEGER,
  build_name TEXT,
  build_hash TEXT,
  blueprint_name TEXT,
  flow_id TEXT,
  flow_version INTEGER,
  repo TEXT,
  branch TEXT,
  build_values TEXT,
  manifest_json TEXT
);

INSERT INTO runs_new (
  rowid, id, build_dir, inputs, status, total_cost, created_at, build_id, deleted_at,
  build_name, build_hash, blueprint_name, flow_id, flow_version, repo, branch, build_values,
  manifest_json)
  SELECT runs.rowid, runs.id, runs.build_dir, runs.inputs, runs.status, runs.total_cost,
         runs.created_at, runs.build_id, runs.deleted_at,
         builds.name, builds.hash, build_snapshots.blueprint_name, builds.flow_id,
         builds.version, builds.repo, builds.branch, builds."values",
         build_manifests.manifest_json
    FROM runs
    LEFT JOIN builds ON builds.id = runs.build_id
    LEFT JOIN build_snapshots ON build_snapshots.build_id = runs.build_id
    LEFT JOIN build_manifests ON build_manifests.build_id = runs.build_id;

DROP TABLE runs;

ALTER TABLE runs_new RENAME TO runs;

CREATE TRIGGER runs_name_their_build BEFORE INSERT ON runs
WHEN NEW.build_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a run names the build it runs');
END;

CREATE TRIGGER runs_name_a_recorded_build BEFORE INSERT ON runs
WHEN NEW.build_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id)
BEGIN
  SELECT RAISE(ABORT, 'a run names a recorded build');
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

CREATE TRIGGER runs_only_deleted_once BEFORE UPDATE OF deleted_at ON runs
WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a run is deleted once');
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

DELETE FROM build_activity WHERE pending_id IN (
  SELECT pending_builds.id FROM pending_builds
    JOIN builds ON builds.id = pending_builds.build_id
   WHERE builds.deleted_at IS NOT NULL);
DELETE FROM build_events WHERE pending_id IN (
  SELECT pending_builds.id FROM pending_builds
    JOIN builds ON builds.id = pending_builds.build_id
   WHERE builds.deleted_at IS NOT NULL);
DELETE FROM pending_builds
 WHERE build_id IN (SELECT id FROM builds WHERE deleted_at IS NOT NULL);
DELETE FROM build_nodes WHERE build_id IN (SELECT id FROM builds WHERE deleted_at IS NOT NULL);
DELETE FROM build_files WHERE build_id IN (SELECT id FROM builds WHERE deleted_at IS NOT NULL);
DELETE FROM build_manifests
 WHERE build_id IN (SELECT id FROM builds WHERE deleted_at IS NOT NULL);
DELETE FROM build_snapshots
 WHERE build_id IN (SELECT id FROM builds WHERE deleted_at IS NOT NULL);
DELETE FROM builds WHERE deleted_at IS NOT NULL;

PRAGMA foreign_key_check;
