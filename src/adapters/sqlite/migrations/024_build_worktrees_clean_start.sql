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

CREATE TABLE build_worktrees (
  id INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  container TEXT NOT NULL,
  repo TEXT NOT NULL,
  base TEXT NOT NULL,
  branch TEXT NOT NULL,
  branch_created INTEGER NOT NULL,
  path TEXT NOT NULL
);

CREATE INDEX build_worktrees_by_build ON build_worktrees (build_id);
