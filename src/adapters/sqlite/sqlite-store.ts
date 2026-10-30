import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { RunEvent } from "../../core/run/run-events.js";
import type {
  EventEntry,
  NewBuild,
  NewRun,
  RunRecord,
  RunStatus,
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
  build_hash: string | null;
};

type EventRow = {
  seq: number;
  node_id: string;
  kind: string;
  payload: string | null;
  time: string;
};

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
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO runs (id, build_dir, inputs, status, created_at, build_hash) VALUES (?, ?, ?, 'running', ?, ?)",
        )
        .run(id, run.buildDir, JSON.stringify(run.inputs), this.time(), run.buildHash ?? null);
      const session = this.db
        .prepare(
          "INSERT INTO run_sessions (run_id, tmux_name, cwd, claude_session_id, status) VALUES (?, ?, ?, ?, 'open')",
        )
        .run(id, run.session.tmuxName, run.session.cwd, run.session.claudeSessionId);
      const insertNode = this.db.prepare(
        "INSERT INTO run_nodes (run_id, node_id, session_id) VALUES (?, ?, ?)",
      );
      for (const nodeId of run.nodeIds) insertNode.run(id, nodeId, session.lastInsertRowid);
    })();
    return { ...run, id, status: "running" };
  }

  findRun(id: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT runs.id, runs.build_dir, runs.inputs, runs.status, runs.build_hash,
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
      ...(row.build_hash === null ? {} : { buildHash: row.build_hash }),
    };
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
            "INSERT INTO events (run_id, node_id, kind, payload, time) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            runId,
            nodeId,
            event.kind,
            "payload" in event && event.payload !== undefined
              ? JSON.stringify(event.payload)
              : null,
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
      .prepare("SELECT seq, node_id, kind, payload, time FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as EventRow[];
    return rows.map(
      (row) =>
        ({
          kind: row.kind,
          ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as unknown }),
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

  recordBuild(build: NewBuild): void {
    this.db
      .prepare("INSERT OR IGNORE INTO builds (hash, dir, created_at) VALUES (?, ?, ?)")
      .run(build.hash, build.dir, this.now().getTime());
  }

  close(): void {
    this.db.close();
  }

  private time(): string {
    return this.now().toISOString();
  }
}
