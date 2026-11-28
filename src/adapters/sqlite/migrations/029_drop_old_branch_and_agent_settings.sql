CREATE TEMP TABLE stored_nodes AS
  SELECT 'flow' AS kind, flow_id AS id, type, settings FROM nodes
  UNION ALL
  SELECT 'build', build_id, type, config FROM build_nodes
  UNION ALL
  SELECT 'build', build_manifests.build_id,
         json_extract(node.value, '$.type'), json_extract(node.value, '$.settings')
    FROM build_manifests,
         json_each(build_manifests.manifest_json, '$.containers') AS container,
         json_each(container.value, '$.nodes') AS node
  UNION ALL
  SELECT 'build', build_snapshots.build_id,
         json_extract(node.value, '$.type'), json_extract(node.value, '$.settings')
    FROM build_snapshots, json_each(build_snapshots.flow_json, '$.nodes') AS node
   WHERE build_snapshots.build_id IS NOT NULL
  UNION ALL
  SELECT 'pending', build_snapshots.pending_id,
         json_extract(node.value, '$.type'), json_extract(node.value, '$.settings')
    FROM build_snapshots, json_each(build_snapshots.flow_json, '$.nodes') AS node
   WHERE build_snapshots.pending_id IS NOT NULL
  UNION ALL
  SELECT 'run', runs.id,
         json_extract(node.value, '$.type'), json_extract(node.value, '$.settings')
    FROM runs,
         json_each(runs.manifest_json, '$.containers') AS container,
         json_each(container.value, '$.nodes') AS node;

CREATE TEMP TABLE removed_holders AS
  SELECT DISTINCT kind, id FROM stored_nodes
   WHERE (type = 'branch'
          AND (json_type(settings, '$.decidedBy') IS NOT NULL
               OR json_type(settings, '$.value') IS NOT NULL))
      OR (type = 'agent'
          AND (json_type(settings, '$.given') IS NOT NULL
               OR json_type(settings, '$.writes') IS NOT NULL
               OR json_type(settings, '$.produces') = 'text'));

CREATE TEMP TABLE gone_flows AS
  SELECT id FROM removed_holders WHERE kind = 'flow';

CREATE TEMP TABLE gone_builds AS
  SELECT id FROM removed_holders WHERE kind = 'build';

CREATE TEMP TABLE gone_runs AS
  SELECT id FROM runs WHERE build_id IN (SELECT id FROM gone_builds)
  UNION
  SELECT id FROM removed_holders WHERE kind = 'run';

CREATE TEMP TABLE gone_pending_builds AS
  SELECT id FROM pending_builds WHERE build_id IN (SELECT id FROM gone_builds)
  UNION
  SELECT id FROM removed_holders WHERE kind = 'pending';

UPDATE runs SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id IN (SELECT id FROM gone_runs) AND deleted_at IS NULL;

DELETE FROM step_texts WHERE run_id IN (SELECT id FROM gone_runs);
DELETE FROM run_repo_states WHERE run_id IN (SELECT id FROM gone_runs);
DELETE FROM run_stories WHERE run_id IN (SELECT id FROM gone_runs);
DELETE FROM activity WHERE run_id IN (SELECT id FROM gone_runs);
DELETE FROM events WHERE run_id IN (SELECT id FROM gone_runs);
DELETE FROM run_nodes WHERE run_id IN (SELECT id FROM gone_runs);
DELETE FROM run_sessions WHERE run_id IN (SELECT id FROM gone_runs);
DELETE FROM runs WHERE id IN (SELECT id FROM gone_runs);

DELETE FROM build_step_texts WHERE pending_id IN (SELECT id FROM gone_pending_builds);
DELETE FROM build_activity WHERE pending_id IN (SELECT id FROM gone_pending_builds);
DELETE FROM build_events WHERE pending_id IN (SELECT id FROM gone_pending_builds);
DELETE FROM build_snapshots
 WHERE pending_id IN (SELECT id FROM gone_pending_builds)
    OR build_id IN (SELECT id FROM gone_builds);
DELETE FROM pending_builds WHERE id IN (SELECT id FROM gone_pending_builds);

DELETE FROM build_manifests WHERE build_id IN (SELECT id FROM gone_builds);
DELETE FROM build_nodes WHERE build_id IN (SELECT id FROM gone_builds);
DELETE FROM build_files WHERE build_id IN (SELECT id FROM gone_builds);
DELETE FROM run_number_counters WHERE build_id IN (SELECT id FROM gone_builds);
DELETE FROM build_worktrees WHERE build_id IN (SELECT id FROM gone_builds);
DELETE FROM builds WHERE id IN (SELECT id FROM gone_builds);

DROP TRIGGER wires_no_delete;
DROP TRIGGER ports_no_delete;
DROP TRIGGER nodes_no_delete;
DROP TRIGGER flow_versions_no_delete;

DELETE FROM wires WHERE flow_id IN (SELECT id FROM gone_flows);
DELETE FROM ports WHERE flow_id IN (SELECT id FROM gone_flows);
DELETE FROM nodes WHERE flow_id IN (SELECT id FROM gone_flows);
DELETE FROM flow_versions WHERE flow_id IN (SELECT id FROM gone_flows);
DELETE FROM flows WHERE id IN (SELECT id FROM gone_flows);

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

DROP TABLE gone_pending_builds;
DROP TABLE gone_runs;
DROP TABLE gone_builds;
DROP TABLE gone_flows;
DROP TABLE removed_holders;
DROP TABLE stored_nodes;
