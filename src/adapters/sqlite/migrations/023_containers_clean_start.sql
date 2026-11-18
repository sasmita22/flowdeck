UPDATE runs SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE deleted_at IS NULL;

DELETE FROM step_texts;
DELETE FROM run_repo_states;
DELETE FROM run_stories;
DELETE FROM activity;
DELETE FROM events;
DELETE FROM run_nodes;
DELETE FROM run_sessions;
DELETE FROM runs;
DELETE FROM run_number_counters;

DELETE FROM build_step_texts;
DELETE FROM build_activity;
DELETE FROM build_events;
DELETE FROM build_snapshots;
DELETE FROM pending_builds;
DELETE FROM build_manifests;
DELETE FROM build_nodes;
DELETE FROM build_files;
DELETE FROM builds;

DROP TRIGGER wires_no_delete;
DROP TRIGGER ports_no_delete;
DROP TRIGGER nodes_no_delete;
DROP TRIGGER flow_versions_no_delete;

DELETE FROM wires;
DELETE FROM ports;
DELETE FROM nodes;
DELETE FROM flow_versions;
DELETE FROM flows;

CREATE TRIGGER wires_no_delete BEFORE DELETE ON wires
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER ports_no_delete BEFORE DELETE ON ports
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER nodes_no_delete BEFORE DELETE ON nodes
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER flow_versions_no_delete BEFORE DELETE ON flow_versions
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

ALTER TABLE flow_versions ADD COLUMN containers TEXT NOT NULL DEFAULT '[]';
