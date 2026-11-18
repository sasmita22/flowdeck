import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { activityEntrySchema, type ActivityEntry } from "../../core/run/activity.js";
import type { VariableValues } from "../../core/flow/variables.js";
import { stateMovingKinds, type RunEvent } from "../../core/run/run-events.js";
import type {
  BuildEvent,
  BuildOutcome,
  PendingBuild,
  StoredBuildEvent,
} from "../../core/run/build-progress.js";
import {
  BuildRunningError,
  type RepoStatePhase,
  type RunBuildCopy,
  type StepText,
  type StepTextField,
} from "../../core/run/store.js";
import { storyPartsOf } from "../../core/run/story.js";
import {
  mergeOtherRepos,
  otherRepoSchema,
  repoStateSchema,
  type OtherRepo,
  type RepoState,
  type RunRepoStates,
} from "../../core/run/repo-state.js";
import type {
  BuildFileRecord,
  BuildRecord,
  BuildSnapshot,
  EventEntry,
  ManifestGap,
  NewBuild,
  NewBuildSnapshot,
  NewPendingBuild,
  NewRun,
  PendingBuildEnd,
  PendingBuildStart,
  RunRecord,
  RunStatus,
  RunStory,
  RunSummary,
  SnapshotGap,
  SnapshotKey,
  Store,
  StoredEvent,
} from "../../ports/store.js";
import { openDatabase } from "./open-database.js";

export type SqliteStoreOptions =
  | { db: Database.Database; now?: () => Date }
  | { path: string; now?: () => Date; migrationsDir?: string };

type RunRow = {
  id: string;
  build_dir: string;
  inputs: string;
  status: RunStatus;
  tmux_name: string;
  cwd: string;
  claude_session_id: string;
  build_id: string | null;
  build_name: string | null;
  build_hash: string | null;
  blueprint_name: string | null;
  flow_id: string | null;
  flow_version: number | null;
  repo: string | null;
  branch: string | null;
  build_values: string | null;
  manifest_json: string | null;
};

type RunSummaryRow = {
  id: string;
  status: RunStatus;
  build_id: string | null;
  created_at: string;
  ended_at: string | null;
  total_cost: number | null;
  node_count: number;
  flow_id: string | null;
  version: number | null;
  build_name: string | null;
  blueprint_name: string | null;
  blueprint_version: number | null;
  build_gone: number;
  number: number;
  done_count: number;
  story_text: string | null;
};

type RunStoryRow = {
  run_id: string;
  at: string;
  run_status: RunStory["runStatus"];
  text: string;
  cost: number;
};

const parsedJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const repoStateOf = (json: string): RepoState => {
  const parsed = repoStateSchema.safeParse(parsedJson(json));
  return parsed.success ? parsed.data : { kind: "unreadable" };
};

const otherReposOf = (json: string): OtherRepo[] => {
  const parsed = otherRepoSchema.array().safeParse(parsedJson(json));
  return parsed.success ? parsed.data : [];
};

const firstLineOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");

const storyLineOf = (text: string | null): { storyLine?: string } => {
  if (text === null) return {};
  const storyLine = firstLineOf(storyPartsOf(text)?.result ?? "") ?? firstLineOf(text);
  return storyLine === undefined ? {} : { storyLine };
};

const toRunSummary = (row: RunSummaryRow): RunSummary => ({
  id: row.id,
  status: row.status,
  ...(row.build_id === null ? {} : { buildId: row.build_id }),
  createdAt: row.created_at,
  endedAt: row.ended_at,
  totalCost: row.total_cost,
  nodeCount: row.node_count,
  ...(row.flow_id === null || row.version === null
    ? {}
    : { source: { flowId: row.flow_id, version: row.version } }),
  buildName: row.build_name,
  blueprintName: row.blueprint_name,
  blueprintVersion: row.blueprint_version,
  buildGone: row.build_gone === 1,
  number: row.number,
  doneCount: row.done_count,
  ...storyLineOf(row.story_text),
});

type BuildRow = {
  id: string;
  hash: string;
  name: string | null;
  repo: string | null;
  base: string | null;
  branch: string | null;
  branch_created: number | null;
  values: string | null;
  deleted_at: number | null;
  dir: string;
  created_at: number;
  flow_id: string | null;
  version: number | null;
  blueprint_name: string | null;
  blueprint_version: number | null;
};

const stateMovingKindList = stateMovingKinds.map((kind) => `'${kind}'`).join(", ");

const runTables = [
  ["step_texts", "run_id"],
  ["run_repo_states", "run_id"],
  ["run_stories", "run_id"],
  ["activity", "run_id"],
  ["events", "run_id"],
  ["run_nodes", "run_id"],
  ["run_sessions", "run_id"],
  ["runs", "id"],
] as const;

const olderAttemptsOf = `SELECT older.id FROM pending_builds AS older
  JOIN pending_builds AS gone ON gone.name = older.name AND gone.id <> older.id
 WHERE gone.id IN (SELECT value FROM json_each(?))
   AND older.build_id IS NULL AND older.ended_at IS NOT NULL
   AND (older.started_at < gone.started_at
     OR (older.started_at = gone.started_at AND older.rowid < gone.rowid))`;

const runSummaries = `
  SELECT runs.id, runs.status, runs.build_id, runs.created_at, runs.total_cost,
         CASE WHEN runs.status = 'running' THEN NULL
              ELSE (SELECT MAX(time) FROM events WHERE events.run_id = runs.id) END AS ended_at,
         (SELECT count(*) FROM run_nodes WHERE run_nodes.run_id = runs.id) AS node_count,
         (SELECT count(*) FROM run_nodes
           WHERE run_nodes.run_id = runs.id
             AND (SELECT events.kind FROM events
                   WHERE events.run_id = run_nodes.run_id AND events.node_id = run_nodes.node_id
                     AND events.kind IN (${stateMovingKindList})
                   ORDER BY events.seq DESC LIMIT 1) = 'done') AS done_count,
         runs.number,
         (SELECT text FROM run_stories WHERE run_stories.run_id = runs.id
           ORDER BY run_stories.seq DESC LIMIT 1) AS story_text,
         builds.id IS NULL AS build_gone,
         runs.flow_id, runs.flow_version AS version, runs.build_name,
         runs.blueprint_name, runs.flow_version AS blueprint_version
    FROM runs LEFT JOIN builds ON builds.id = runs.build_id`;

const runBuildCopy = `SELECT builds.name, builds.hash, build_snapshots.blueprint_name, builds.flow_id,
       builds.version, builds.repo, builds.branch, builds."values", build_manifests.manifest_json
  FROM (SELECT ? AS id) AS named
       LEFT JOIN builds ON builds.id = named.id
       LEFT JOIN build_snapshots ON build_snapshots.build_id = named.id
       LEFT JOIN build_manifests ON build_manifests.build_id = named.id`;

const toRunBuildCopy = (row: RunRow): RunBuildCopy => ({
  buildName: row.build_name,
  buildHash: row.build_hash,
  blueprintName: row.blueprint_name,
  ...(row.flow_id === null || row.flow_version === null
    ? {}
    : { source: { flowId: row.flow_id, version: row.flow_version } }),
  repo: row.repo,
  branch: row.branch,
  buildValues: row.build_values === null ? null : (JSON.parse(row.build_values) as VariableValues),
  manifestJson: row.manifest_json,
});

const buildsWithSnapshot = `SELECT builds.id, builds.hash, builds.name, builds.repo, builds.base,
       builds.branch, builds.branch_created, builds."values", builds.deleted_at, builds.dir, builds.created_at, builds.flow_id,
       builds.version, build_snapshots.blueprint_name, build_snapshots.version AS blueprint_version
  FROM builds LEFT JOIN build_snapshots ON build_snapshots.build_id = builds.id`;

const toBuild = (row: BuildRow): BuildRecord => ({
  id: row.id,
  hash: row.hash,
  name: row.name,
  repo: row.repo,
  base: row.base,
  branch: row.branch,
  branchCreated: row.branch_created === null ? null : row.branch_created === 1,
  values: row.values === null ? null : (JSON.parse(row.values) as VariableValues),
  deletedAt: row.deleted_at,
  dir: row.dir,
  createdAt: row.created_at,
  ...(row.flow_id === null || row.version === null
    ? {}
    : { source: { flowId: row.flow_id, version: row.version } }),
  blueprintName: row.blueprint_name,
  blueprintVersion: row.blueprint_version,
});

type EventRow = {
  seq: number;
  node_id: string;
  kind: string;
  payload: string | null;
  tokens: number | null;
  cost: number | null;
  time: string;
};

type PendingBuildRow = {
  id: string;
  flow_id: string;
  version: number;
  name: string;
  origin_json: string;
  started_at: number;
  ended_at: number | null;
  outcome: BuildOutcome | null;
  build_id: string | null;
  report_json: string | null;
};

const pendingColumns =
  "id, flow_id, version, name, origin_json, started_at, ended_at, outcome, build_id, report_json";

const toPendingBuild = (row: PendingBuildRow): PendingBuild => ({
  id: row.id,
  flowId: row.flow_id,
  version: row.version,
  name: row.name,
  origin: JSON.parse(row.origin_json) as unknown,
  startedAt: row.started_at,
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  ...(row.outcome === null ? {} : { outcome: row.outcome }),
  ...(row.build_id === null ? {} : { buildId: row.build_id }),
  ...(row.report_json === null ? {} : { report: JSON.parse(row.report_json) as unknown }),
});

type BuildBodyRow = { seq: number; at: number; body_json: string };

type SnapshotRow = {
  pending_id: string | null;
  build_id: string | null;
  blueprint_name: string;
  version: number;
  svg: string;
};

const toSnapshot = (row: SnapshotRow): BuildSnapshot => ({
  blueprintName: row.blueprint_name,
  version: row.version,
  svg: row.svg,
  pendingId: row.pending_id,
  buildId: row.build_id,
});

type SnapshotGapRow = {
  pending_id: string | null;
  build_id: string | null;
  flow_id: string | null;
  version: number | null;
  blueprint_name: string | null;
};

const buildRunningMessage = "build is running";

const asBuildRunning = (error: unknown, buildId: string | undefined): unknown =>
  error instanceof Database.SqliteError &&
  error.code === "SQLITE_CONSTRAINT_TRIGGER" &&
  error.message === buildRunningMessage
    ? new BuildRunningError(buildId ?? "")
    : error;

const nodeUpdates: Partial<Record<RunEvent["kind"], string>> = {
  sent: "started_at = coalesce(started_at, @time)",
  running: "started_at = coalesce(started_at, @time)",
  done: "finished_at = @time",
  failed: "finished_at = @time",
  skipped: "finished_at = @time",
  retry: "retries = retries + 1",
  reset: "finished_at = NULL",
};

export class SqliteStore implements Store {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: SqliteStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.db = "db" in options ? options.db : openDatabase({ ...options, now: this.now });
  }

  createRun(run: NewRun): RunRecord {
    const id = randomUUID();
    this.guarded(run.buildId, () => {
      this.db
        .prepare(
          `INSERT INTO run_number_counters (build_id, last) VALUES (?, 1)
           ON CONFLICT (build_id) DO UPDATE SET last = last + 1`,
        )
        .run(run.buildId);
      this.db
        .prepare(
          `INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id, number,
                             build_name, build_hash, blueprint_name, flow_id, flow_version, repo,
                             branch, build_values, manifest_json)
           SELECT ?, ?, ?, 'running', ?, ?,
                  (SELECT last FROM run_number_counters WHERE build_id = ?), copy.*
             FROM (${runBuildCopy}) AS copy`,
        )
        .run(
          id,
          run.buildDir,
          JSON.stringify(run.inputs),
          this.time(),
          run.buildId,
          run.buildId,
          run.buildId,
        );
      const session = this.db
        .prepare(
          "INSERT INTO run_sessions (run_id, tmux_name, cwd, claude_session_id, status) VALUES (?, ?, ?, ?, 'open')",
        )
        .run(id, run.session.tmuxName, run.session.cwd, run.session.claudeSessionId);
      const insertNode = this.db.prepare(
        "INSERT INTO run_nodes (run_id, node_id, session_id) VALUES (?, ?, ?)",
      );
      for (const nodeId of run.nodeIds) insertNode.run(id, nodeId, session.lastInsertRowid);
    });
    const created = this.findRun(id);
    if (created === undefined) throw new Error(`run ${id} was not recorded`);
    return created;
  }

  findRun(id: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT runs.id, runs.build_dir, runs.inputs, runs.status, runs.build_id,
                runs.build_name, runs.build_hash, runs.blueprint_name, runs.flow_id,
                runs.flow_version, runs.repo, runs.branch, runs.build_values, runs.manifest_json,
                run_sessions.tmux_name, run_sessions.cwd, run_sessions.claude_session_id
           FROM runs JOIN run_sessions ON run_sessions.run_id = runs.id
          WHERE runs.id = ? ORDER BY run_sessions.id LIMIT 1`,
      )
      .get(id) as RunRow | undefined;
    if (row === undefined) return undefined;
    const nodeIds = (
      this.db.prepare("SELECT node_id FROM run_nodes WHERE run_id = ? ORDER BY rowid").all(id) as {
        node_id: string;
      }[]
    ).map((node) => node.node_id);
    return {
      id: row.id,
      buildDir: row.build_dir,
      inputs: JSON.parse(row.inputs) as Record<string, unknown>,
      nodeIds,
      session: { tmuxName: row.tmux_name, cwd: row.cwd, claudeSessionId: row.claude_session_id },
      status: row.status,
      ...(row.build_id === null ? {} : { buildId: row.build_id }),
      ...toRunBuildCopy(row),
    };
  }

  listRuns(): RunSummary[] {
    const rows = this.db
      .prepare(
        `${runSummaries}
          WHERE runs.deleted_at IS NULL
          ORDER BY runs.status = 'running' DESC, runs.created_at DESC, runs.rowid DESC`,
      )
      .all() as RunSummaryRow[];
    return rows.map(toRunSummary);
  }

  findRunSummary(id: string): RunSummary | undefined {
    const row = this.db.prepare(`${runSummaries} WHERE runs.id = ?`).get(id) as
      RunSummaryRow | undefined;
    return row === undefined ? undefined : toRunSummary(row);
  }

  append(runId: string, nodeId: string, event: RunEvent): void {
    this.appendAll(runId, [{ nodeId, event }]);
  }

  appendAll(runId: string, entries: readonly EventEntry[]): void {
    const time = this.time();
    this.db.transaction(() => {
      for (const { nodeId, event } of entries) {
        this.db
          .prepare(
            "INSERT INTO events (run_id, node_id, kind, payload, tokens, cost, time) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            runId,
            nodeId,
            event.kind,
            "payload" in event && event.payload !== undefined
              ? JSON.stringify(event.payload)
              : null,
            event.kind === "usage" ? event.tokens : null,
            event.kind === "usage" ? event.cost : null,
            time,
          );
        const update = nodeUpdates[event.kind];
        if (update !== undefined) {
          this.db
            .prepare(`UPDATE run_nodes SET ${update} WHERE run_id = @runId AND node_id = @nodeId`)
            .run({ runId, nodeId, time });
        }
      }
    })();
  }

  events(runId: string): StoredEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, node_id, kind, payload, tokens, cost, time FROM events WHERE run_id = ? ORDER BY seq",
      )
      .all(runId) as EventRow[];
    return rows.map(
      (row) =>
        ({
          kind: row.kind,
          ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as unknown }),
          ...(row.tokens === null ? {} : { tokens: row.tokens }),
          ...(row.cost === null ? {} : { cost: row.cost }),
          nodeId: row.node_id,
          seq: row.seq,
          time: row.time,
        }) as StoredEvent,
    );
  }

  finishRun(runId: string, status: Exclude<RunStatus, "running">): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, runId);
      this.db.prepare("UPDATE run_sessions SET status = 'closed' WHERE run_id = ?").run(runId);
    })();
  }

  reopenRun(runId: string): void {
    this.guarded(this.findRun(runId)?.buildId, () => {
      this.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE run_sessions SET status = 'open' WHERE run_id = ?").run(runId);
    });
  }

  deleteRun(runId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE runs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(this.now().getTime(), runId);
      for (const [table, column] of runTables) {
        this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(runId);
      }
    })();
  }

  stopRun(runId: string): void {
    this.db.transaction(() => {
      const stopped = this.db
        .prepare("UPDATE runs SET status = 'stopped' WHERE id = ? AND status = 'running'")
        .run(runId);
      if (stopped.changes > 0) {
        this.db.prepare("UPDATE run_sessions SET status = 'closed' WHERE run_id = ?").run(runId);
      }
    })();
  }

  recordActivity(runId: string, entry: ActivityEntry): void {
    this.db
      .prepare("INSERT INTO activity (run_id, id, node_id, entry) VALUES (?, ?, ?, ?)")
      .run(runId, entry.id, entry.nodeId, JSON.stringify(entry));
  }

  appendRunStory(story: RunStory): void {
    this.db
      .prepare(
        "INSERT INTO run_stories (run_id, at, run_status, text, cost) VALUES (?, ?, ?, ?, ?)",
      )
      .run(story.runId, story.at, story.runStatus, story.text, story.cost);
  }

  latestRunStory(runId: string): RunStory | undefined {
    const row = this.db
      .prepare(
        "SELECT run_id, at, run_status, text, cost FROM run_stories WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(runId) as RunStoryRow | undefined;
    return row === undefined
      ? undefined
      : {
          runId: row.run_id,
          at: row.at,
          runStatus: row.run_status,
          text: row.text,
          cost: row.cost,
        };
  }

  appendRepoState(
    runId: string,
    phase: RepoStatePhase,
    state: RepoState,
    otherRepos: OtherRepo[],
  ): void {
    this.db
      .prepare(
        "INSERT INTO run_repo_states (run_id, phase, state_json, other_repos_json, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, phase, JSON.stringify(state), JSON.stringify(otherRepos), this.now().getTime());
  }

  appendOtherRepoBefore(runId: string, repo: string, state: RepoState): void {
    this.db
      .prepare(
        "INSERT INTO run_repo_states (run_id, phase, state_json, other_repos_json, at, repo) VALUES (?, 'before', ?, '[]', ?, ?)",
      )
      .run(runId, JSON.stringify(state), this.now().getTime(), repo);
  }

  repoStates(runId: string): RunRepoStates {
    const row = (phase: RepoStatePhase, order: "ASC" | "DESC") =>
      this.db
        .prepare(
          `SELECT state_json, other_repos_json FROM run_repo_states WHERE run_id = ? AND phase = ? AND repo IS NULL ORDER BY id ${order} LIMIT 1`,
        )
        .get(runId, phase) as { state_json: string; other_repos_json: string } | undefined;
    const before = row("before", "ASC");
    const after = row("after", "DESC");
    const otherBefores = this.db
      .prepare(
        `SELECT repo, state_json FROM run_repo_states AS first
          WHERE run_id = ? AND phase = 'before' AND repo IS NOT NULL
            AND id = (SELECT MIN(id) FROM run_repo_states
                       WHERE run_id = first.run_id AND phase = 'before' AND repo = first.repo)`,
      )
      .all(runId) as { repo: string; state_json: string }[];
    return {
      before: before === undefined ? null : repoStateOf(before.state_json),
      after: after === undefined ? null : repoStateOf(after.state_json),
      otherRepos: mergeOtherRepos(
        new Map(otherBefores.map((other) => [other.repo, repoStateOf(other.state_json)])),
        after === undefined ? [] : otherReposOf(after.other_repos_json),
      ),
    };
  }

  appendStepText(runId: string, entryId: number, field: StepTextField, text: string): void {
    this.db
      .prepare("INSERT INTO step_texts (run_id, entry_id, field, text, at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, entryId, field, text, this.now().getTime());
  }

  stepTexts(runId: string, entryId: number): StepText[] {
    return this.db
      .prepare(
        `SELECT field, text FROM step_texts AS latest
         WHERE run_id = ? AND entry_id = ?
           AND id = (SELECT MAX(id) FROM step_texts
                     WHERE run_id = latest.run_id AND entry_id = latest.entry_id AND field = latest.field)
         ORDER BY field`,
      )
      .all(runId, entryId) as StepText[];
  }

  appendBuildStepText(
    pendingId: string,
    entryId: number,
    field: StepTextField,
    text: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO build_step_texts (pending_id, entry_id, field, text, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(pendingId, entryId, field, text, this.now().getTime());
  }

  buildStepTexts(pendingId: string, entryId: number): StepText[] {
    return this.db
      .prepare(
        `SELECT field, text FROM build_step_texts AS latest
         WHERE pending_id = ? AND entry_id = ?
           AND id = (SELECT MAX(id) FROM build_step_texts
                     WHERE pending_id = latest.pending_id AND entry_id = latest.entry_id
                       AND field = latest.field)
         ORDER BY id`,
      )
      .all(pendingId, entryId) as StepText[];
  }

  activity(runId: string): ActivityEntry[] {
    const rows = this.db
      .prepare(
        `SELECT entry FROM activity AS latest
         WHERE run_id = ?
           AND seq = (SELECT MAX(seq) FROM activity WHERE run_id = latest.run_id AND id = latest.id)
         ORDER BY id`,
      )
      .all(runId) as { entry: string }[];
    return rows.flatMap((row) => {
      const parsed = activityEntrySchema.safeParse(JSON.parse(row.entry));
      return parsed.success ? [parsed.data] : [];
    });
  }

  recordCost(runId: string, totalCost: number): void {
    this.db.prepare("UPDATE runs SET total_cost = ? WHERE id = ?").run(totalCost, runId);
  }

  recordBuild(build: NewBuild): void {
    this.db.transaction(() => {
      const insertFile = this.db.prepare(
        "INSERT INTO build_files (build_id, path, sha256) VALUES (?, ?, ?)",
      );
      for (const file of build.files) insertFile.run(build.id, file.path, file.sha256);
      const insertNode = this.db.prepare(
        "INSERT INTO build_nodes (build_id, ordinal, node_id, type, config, file) VALUES (?, ?, ?, ?, ?, ?)",
      );
      build.nodes.forEach((node, ordinal) => {
        insertNode.run(
          build.id,
          ordinal,
          node.nodeId,
          node.type,
          JSON.stringify(node.config),
          node.file ?? null,
        );
      });
      this.db
        .prepare(
          'INSERT INTO builds (id, hash, name, repo, base, branch, branch_created, "values", dir, created_at, flow_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          build.id,
          build.hash,
          build.name,
          build.repo,
          build.base,
          build.branch,
          build.branchCreated ? 1 : 0,
          JSON.stringify(build.values),
          build.dir,
          this.now().getTime(),
          build.source?.flowId ?? null,
          build.source?.version ?? null,
        );
      this.db
        .prepare("INSERT INTO build_manifests (build_id, manifest_json) VALUES (?, ?)")
        .run(build.id, build.manifest);
    })();
  }

  findBuild(id: string): BuildRecord | undefined {
    const row = this.db.prepare(`${buildsWithSnapshot} WHERE builds.id = ?`).get(id) as
      BuildRow | undefined;
    return row === undefined ? undefined : toBuild(row);
  }

  findBuildByName(name: string): BuildRecord | undefined {
    const row = this.db
      .prepare(`${buildsWithSnapshot} WHERE builds.name = ? AND builds.deleted_at IS NULL`)
      .get(name) as BuildRow | undefined;
    return row === undefined ? undefined : toBuild(row);
  }

  deleteBuild(id: string): void {
    this.db.transaction(() => {
      const pendingOfBuild = this.db
        .prepare("SELECT id FROM pending_builds WHERE build_id = ?")
        .pluck()
        .all(id) as string[];
      this.removePendingBuilds(pendingOfBuild);
      for (const table of ["build_nodes", "build_files", "build_manifests", "build_snapshots"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE build_id = ?`).run(id);
      }
      this.db.prepare("DELETE FROM run_number_counters WHERE build_id = ?").run(id);
      this.db.prepare("DELETE FROM builds WHERE id = ?").run(id);
    })();
  }

  listBuilds(): BuildRecord[] {
    return this.selectBuilds("WHERE builds.deleted_at IS NULL");
  }

  private selectBuilds(where: string): BuildRecord[] {
    const rows = this.db
      .prepare(`${buildsWithSnapshot} ${where} ORDER BY builds.created_at DESC, builds.rowid DESC`)
      .all() as BuildRow[];
    return rows.map(toBuild);
  }

  startPendingBuild(build: NewPendingBuild): PendingBuildStart {
    const pendingId = randomUUID();
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            pendingId,
            build.flowId,
            build.version,
            build.name,
            JSON.stringify(build.origin),
            build.startedAt,
          );
        if (build.snapshot !== undefined) {
          this.insertSnapshot({ pendingId, buildId: null }, build.snapshot, build.startedAt);
        }
      })();
    } catch (error) {
      if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_CONSTRAINT_UNIQUE") {
        throw error;
      }
      return { kind: "busy", reason: "name" };
    }
    return { kind: "started", pendingId };
  }

  appendBuildEvent(pendingId: string, event: BuildEvent): void {
    this.appendBuildRow("build_events", pendingId, event);
  }

  buildEvents(pendingId: string): StoredBuildEvent[] {
    return this.buildRows("build_events", pendingId).map((row) => ({
      ...(JSON.parse(row.body_json) as BuildEvent),
      seq: row.seq,
      at: row.at,
    }));
  }

  endPendingBuild(pendingId: string, end: PendingBuildEnd): void {
    this.db.transaction(() => {
      const ended = this.db
        .prepare(
          "UPDATE pending_builds SET ended_at = ?, outcome = ?, build_id = ?, report_json = ? WHERE id = ? AND ended_at IS NULL",
        )
        .run(
          end.endedAt,
          end.outcome,
          end.buildId ?? null,
          end.report === undefined ? null : JSON.stringify(end.report),
          pendingId,
        );
      if (ended.changes === 0) throw new Error(`no open pending build ${pendingId}`);
      if (end.buildId !== undefined) {
        this.db
          .prepare(
            "UPDATE build_snapshots SET build_id = ? WHERE pending_id = ? AND build_id IS NULL",
          )
          .run(end.buildId, pendingId);
      }
    })();
  }

  listPendingBuilds(): PendingBuild[] {
    const rows = this.db
      .prepare(
        `SELECT ${pendingColumns} FROM pending_builds WHERE ended_at IS NULL AND deleted_at IS NULL ORDER BY started_at, rowid`,
      )
      .all() as PendingBuildRow[];
    return rows.map(toPendingBuild);
  }

  listLatestEndedPendingBuildsByName(): PendingBuild[] {
    const rows = this.db
      .prepare(
        `SELECT ${pendingColumns} FROM pending_builds AS ended
         WHERE ended_at IS NOT NULL AND outcome IS NOT 'built' AND deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM pending_builds AS later
           WHERE later.name = ended.name AND later.ended_at IS NOT NULL
             AND (later.ended_at > ended.ended_at
               OR (later.ended_at = ended.ended_at AND later.rowid > ended.rowid))
         )
         ORDER BY ended_at, rowid`,
      )
      .all() as PendingBuildRow[];
    return rows.map(toPendingBuild);
  }

  findPendingBuildByName(name: string): PendingBuild | undefined {
    const row = this.db
      .prepare(`SELECT ${pendingColumns} FROM pending_builds WHERE name = ? AND ended_at IS NULL`)
      .get(name) as PendingBuildRow | undefined;
    return row === undefined ? undefined : toPendingBuild(row);
  }

  pendingBuild(id: string): PendingBuild | null {
    const row = this.db
      .prepare(`SELECT ${pendingColumns} FROM pending_builds WHERE id = ?`)
      .get(id) as PendingBuildRow | undefined;
    return row === undefined ? null : toPendingBuild(row);
  }

  deletePendingBuild(id: string): void {
    this.db.transaction(() => {
      this.removePendingBuilds([id]);
    })();
  }

  appendBuildActivity(pendingId: string, entry: ActivityEntry): void {
    this.appendBuildRow("build_activity", pendingId, entry);
  }

  buildActivity(pendingId: string): ActivityEntry[] {
    return this.buildRows("build_activity", pendingId).flatMap((row) => {
      const parsed = activityEntrySchema.safeParse(JSON.parse(row.body_json));
      return parsed.success ? [parsed.data] : [];
    });
  }

  buildSnapshot(key: SnapshotKey): BuildSnapshot | null {
    const [column, id] =
      "pendingId" in key ? ["pending_id", key.pendingId] : ["build_id", key.buildId];
    const row = this.db
      .prepare(
        `SELECT pending_id, build_id, blueprint_name, version, svg FROM build_snapshots WHERE ${column} = ?`,
      )
      .get(id) as SnapshotRow | undefined;
    return row === undefined ? null : toSnapshot(row);
  }

  listSnapshotGaps(): SnapshotGap[] {
    const rows = this.db
      .prepare(
        `SELECT id AS pending_id, build_id, flow_id, version,
                json_extract(origin_json, '$.blueprint.name') AS blueprint_name,
                0 AS part, rowid AS ordinal
           FROM pending_builds
          WHERE NOT EXISTS (SELECT 1 FROM build_snapshots WHERE pending_id = pending_builds.id)
         UNION ALL
         SELECT NULL, id, flow_id, version, NULL, 1, rowid
           FROM builds
          WHERE NOT EXISTS (SELECT 1 FROM build_snapshots WHERE build_id = builds.id)
            AND NOT EXISTS (
              SELECT 1 FROM pending_builds WHERE name = builds.name AND ended_at IS NULL)
         ORDER BY part, ordinal`,
      )
      .all() as SnapshotGapRow[];
    return rows.map((row) => ({
      pendingId: row.pending_id,
      buildId: row.build_id,
      flowId: row.flow_id,
      version: row.version,
      blueprintName: row.blueprint_name,
    }));
  }

  addSnapshotIfMissing(
    gap: Pick<SnapshotGap, "pendingId" | "buildId">,
    snapshot: NewBuildSnapshot,
  ): boolean {
    return this.insertSnapshot(gap, snapshot, this.now().getTime());
  }

  storeManifest({ buildId, manifest }: { buildId: string; manifest: string }): void {
    this.db
      .prepare(
        `INSERT INTO build_manifests (build_id, manifest_json)
         SELECT @buildId, @manifest
          WHERE NOT EXISTS (SELECT 1 FROM build_manifests WHERE build_id = @buildId)`,
      )
      .run({ buildId, manifest });
  }

  buildManifest(buildId: string): string | undefined {
    const row = this.db
      .prepare("SELECT manifest_json FROM build_manifests WHERE build_id = ?")
      .get(buildId) as { manifest_json: string } | undefined;
    return row?.manifest_json;
  }

  listManifestGaps(): ManifestGap[] {
    return this.db
      .prepare(
        `SELECT builds.id AS buildId, build_files.sha256 AS manifestSha256
           FROM builds
           JOIN build_files ON build_files.build_id = builds.id AND build_files.path = 'manifest.json'
          WHERE NOT EXISTS (SELECT 1 FROM build_manifests WHERE build_id = builds.id)
          ORDER BY builds.rowid`,
      )
      .all() as ManifestGap[];
  }

  buildFiles(id: string): BuildFileRecord[] {
    return this.db
      .prepare("SELECT path, sha256 FROM build_files WHERE build_id = ? ORDER BY path")
      .all(id) as BuildFileRecord[];
  }

  close(): void {
    this.db.close();
  }

  private guarded(buildId: string | undefined, write: () => void): void {
    try {
      this.db.transaction(write)();
    } catch (error) {
      throw asBuildRunning(error, buildId);
    }
  }

  private insertSnapshot(
    keys: Pick<SnapshotGap, "pendingId" | "buildId">,
    snapshot: NewBuildSnapshot,
    createdAt: number,
  ): boolean {
    const inserted = this.db
      .prepare(
        `INSERT INTO build_snapshots (pending_id, build_id, blueprint_name, version, svg, created_at)
         SELECT @pendingId, @buildId, @blueprintName, @version, @svg, @createdAt
          WHERE NOT EXISTS (
            SELECT 1 FROM build_snapshots WHERE pending_id = @pendingId OR build_id = @buildId)`,
      )
      .run({
        pendingId: keys.pendingId,
        buildId: keys.buildId,
        blueprintName: snapshot.blueprintName,
        version: snapshot.version,
        svg: snapshot.svg,
        createdAt,
      });
    return inserted.changes > 0;
  }

  private removePendingBuilds(ids: readonly string[]): void {
    const older = this.db.prepare(olderAttemptsOf).pluck().all(JSON.stringify(ids)) as string[];
    const gone = JSON.stringify([...ids, ...older]);
    const goneIds = "SELECT value FROM json_each(?)";
    for (const table of ["build_activity", "build_events", "build_step_texts"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE pending_id IN (${goneIds})`).run(gone);
    }
    this.db
      .prepare(`DELETE FROM build_snapshots WHERE pending_id IN (${goneIds}) AND build_id IS NULL`)
      .run(gone);
    this.db.prepare(`DELETE FROM pending_builds WHERE id IN (${goneIds})`).run(gone);
  }

  private appendBuildRow(
    table: "build_events" | "build_activity",
    pendingId: string,
    body: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (pending_id, seq, at, body_json)
         SELECT @pendingId, coalesce(MAX(seq), 0) + 1, @at, @body FROM ${table} WHERE pending_id = @pendingId`,
      )
      .run({ pendingId, at: this.now().getTime(), body: JSON.stringify(body) });
  }

  private buildRows(table: "build_events" | "build_activity", pendingId: string): BuildBodyRow[] {
    return this.db
      .prepare(`SELECT seq, at, body_json FROM ${table} WHERE pending_id = ? ORDER BY seq`)
      .all(pendingId) as BuildBodyRow[];
  }

  private time(): string {
    return this.now().toISOString();
  }
}
