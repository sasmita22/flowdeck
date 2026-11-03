import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { activityEntrySchema, type ActivityEntry } from "../../core/run/activity.js";
import type { VariableValues } from "../../core/flow/variables.js";
import type { RunEvent } from "../../core/run/run-events.js";
import { BuildRunningError } from "../../core/run/store.js";
import type {
  BuildFileRecord,
  BuildRecord,
  EventEntry,
  NewBuild,
  NewRun,
  RunRecord,
  RunStatus,
  RunSummary,
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
});

type BuildRow = {
  id: string;
  hash: string;
  name: string | null;
  repo: string | null;
  base: string | null;
  values: string | null;
  deleted_at: number | null;
  dir: string;
  created_at: number;
  flow_id: string | null;
  version: number | null;
};

const buildColumns =
  'id, hash, name, repo, base, "values", deleted_at, dir, created_at, flow_id, version';

const toBuild = (row: BuildRow): BuildRecord => ({
  id: row.id,
  hash: row.hash,
  name: row.name,
  repo: row.repo,
  base: row.base,
  values: row.values === null ? null : (JSON.parse(row.values) as VariableValues),
  deletedAt: row.deleted_at,
  dir: row.dir,
  createdAt: row.created_at,
  ...(row.flow_id === null || row.version === null
    ? {}
    : { source: { flowId: row.flow_id, version: row.version } }),
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
          "INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id) VALUES (?, ?, ?, 'running', ?, ?)",
        )
        .run(id, run.buildDir, JSON.stringify(run.inputs), this.time(), run.buildId);
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
    return { ...run, id, status: "running" };
  }

  findRun(id: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT runs.id, runs.build_dir, runs.inputs, runs.status, runs.build_id,
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
    };
  }

  listRuns(): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT runs.id, runs.status, runs.build_id, runs.created_at, runs.total_cost,
                CASE WHEN runs.status = 'running' THEN NULL
                     ELSE (SELECT MAX(time) FROM events WHERE events.run_id = runs.id) END AS ended_at,
                (SELECT count(*) FROM run_nodes WHERE run_nodes.run_id = runs.id) AS node_count,
                builds.flow_id, builds.version
           FROM runs LEFT JOIN builds ON builds.id = runs.build_id
          WHERE builds.deleted_at IS NULL
          ORDER BY runs.status = 'running' DESC, runs.created_at DESC, runs.rowid DESC`,
      )
      .all() as RunSummaryRow[];
    return rows.map(toRunSummary);
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
          'INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at, flow_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          build.id,
          build.hash,
          build.name,
          build.repo,
          build.base,
          JSON.stringify(build.values),
          build.dir,
          this.now().getTime(),
          build.source?.flowId ?? null,
          build.source?.version ?? null,
        );
    })();
  }

  findBuild(id: string): BuildRecord | undefined {
    const row = this.db.prepare(`SELECT ${buildColumns} FROM builds WHERE id = ?`).get(id) as
      BuildRow | undefined;
    return row === undefined ? undefined : toBuild(row);
  }

  findBuildByName(name: string): BuildRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${buildColumns} FROM builds WHERE name = ? AND deleted_at IS NULL`)
      .get(name) as BuildRow | undefined;
    return row === undefined ? undefined : toBuild(row);
  }

  deleteBuild(id: string): void {
    this.db.prepare("UPDATE builds SET deleted_at = ? WHERE id = ?").run(this.now().getTime(), id);
  }

  listBuilds(): BuildRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${buildColumns} FROM builds WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as BuildRow[];
    return rows.map(toBuild);
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

  private time(): string {
    return this.now().toISOString();
  }
}
