import Database from "better-sqlite3";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import { BuildRunningError } from "../../../src/core/run/store.js";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import type { BuildEvent } from "../../../src/core/run/build-progress.js";
import type { NewBuild, NewPendingBuild, NewRun } from "../../../src/ports/store.js";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { agent, flow } from "../../fixtures/flow-builders.js";

const newRun = (nodeIds = ["p1", "p2", "p3"], buildId = "b1"): NewRun => ({
  buildDir: `/fd/workspaces/${buildId}`,
  inputs: { auto: true },
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildId,
});

const build: NewBuild = {
  id: "b1",
  hash: "abc",
  name: "fix-login",
  repo: "/repo",
  base: "main",
  values: { ticket: "FD-1" },
  dir: "/fd/workspaces/b1",
  files: [],
  nodes: [],
};

const another = (id: string, name: string): NewBuild => ({
  ...build,
  id,
  name,
  dir: `/fd/workspaces/${id}`,
});

const pending = (flowId = "flow-1", name = "nightly"): NewPendingBuild => ({
  flowId,
  version: 3,
  name,
  origin: { kind: "canvas" },
  startedAt: 1_000,
});

const startedId = (store: SqliteStore, build: NewPendingBuild): string => {
  const start = store.startPendingBuild(build);
  if (start.kind !== "started") throw new Error(`expected a start, got ${start.reason}`);
  return start.pendingId;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("SqliteStore", () => {
  let folder: string;
  let path: string;
  const opened: { close(): void }[] = [];

  const open = (now?: () => Date) => {
    const store = new SqliteStore(now === undefined ? { path } : { path, now });
    opened.push(store);
    store.recordBuild(build);
    return store;
  };

  const raw = () => {
    const db = new Database(path);
    opened.push(db);
    return db;
  };

  const count = (db: Database.Database, table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-sqlite-"));
    path = join(folder, "flowdeck.db");
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("creates a missing folder and the database file in it", async () => {
    path = join(folder, "missing", "flowdeck.db");

    open();

    await expect(access(path)).resolves.toBeUndefined();
  });

  it("runs no migrations from an empty migrations folder, so the first write finds no table", async () => {
    const migrationsDir = join(folder, "no-migrations");
    await mkdir(migrationsDir);
    const store = new SqliteStore({ path, migrationsDir });
    opened.push(store);

    expect(() => store.createRun(newRun())).toThrow(/no such table/);
  });

  it("migrates from the migrations folder it is given", async () => {
    const migrationsDir = join(folder, "copied-migrations");
    await cp(new URL("../../../src/adapters/sqlite/migrations/", import.meta.url), migrationsDir, {
      recursive: true,
    });
    const store = new SqliteStore({ path, migrationsDir });
    opened.push(store);
    store.recordBuild(build);

    expect(store.createRun(newRun()).status).toBe("running");
  });

  it("migrates a fresh database once and reopens it without migrating again or losing rows", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.append(id, "p1", { kind: "sent" });
    const db = raw();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    const counts = () =>
      ["runs", "run_sessions", "run_nodes", "events", "migrations"].map((t) => count(db, t));
    const before = counts();
    store.close();

    opened.push(new SqliteStore({ path }));

    expect(tables).toEqual(
      expect.arrayContaining(["runs", "run_sessions", "run_nodes", "events", "builds"]),
    );
    expect(db.prepare("SELECT name FROM migrations ORDER BY name").all()).toEqual([
      { name: "001_runs.sql" },
      { name: "002_flows.sql" },
      { name: "003_builds.sql" },
      { name: "004_events_lock.sql" },
      { name: "005_notes.sql" },
      { name: "006_build_lineage.sql" },
      { name: "007_activity.sql" },
      { name: "008_named_builds.sql" },
      { name: "009_build_progress.sql" },
      { name: "010_flow_pinned.sql" },
      { name: "011_build_snapshots.sql" },
    ]);
    expect(counts()).toEqual(before);
    expect(before).toEqual([1, 1, 3, 1, 11]);
  });

  it("writes one run, one session and one row per node", () => {
    const { id } = open().createRun(newRun());
    const db = raw();

    expect(id).toMatch(uuid);
    expect(db.prepare("SELECT id, status, build_dir FROM runs").all()).toEqual([
      { id, status: "running", build_dir: "/fd/workspaces/b1" },
    ]);
    expect(
      db
        .prepare("SELECT run_id, tmux_name, cwd, claude_session_id, parent FROM run_sessions")
        .all(),
    ).toEqual([
      { run_id: id, tmux_name: "fd-run", cwd: "/repo", claude_session_id: "c1", parent: null },
    ]);
    expect(db.prepare("SELECT node_id FROM run_nodes ORDER BY node_id").all()).toEqual([
      { node_id: "p1" },
      { node_id: "p2" },
      { node_id: "p3" },
    ]);
  });

  it("keeps no node status column; status is the fold of the node's events", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.append(id, "p1", { kind: "sent" });
    store.append(id, "p1", { kind: "done", payload: { stopMessage: "OK" } });
    const columns = (raw().prepare("PRAGMA table_info(run_nodes)").all() as { name: string }[]).map(
      (column) => column.name,
    );

    expect(columns).not.toContain("status");
    expect(nodeStatus(store.events(id).filter((event) => event.nodeId === "p1"))).toBe("done");
    expect(store.events(id).at(-1)).toMatchObject({ kind: "done", payload: { stopMessage: "OK" } });
  });

  it("stamps event times and keeps run_nodes times and retries in step with the events", () => {
    let at = new Date("2026-01-01T00:00:00Z");
    const store = open(() => at);
    const { id } = store.createRun(newRun(["s1", "p1"]));
    const node = (nodeId: string) =>
      raw()
        .prepare("SELECT started_at, finished_at, retries FROM run_nodes WHERE node_id = ?")
        .get(nodeId);

    store.append(id, "s1", { kind: "running" });
    at = new Date("2026-01-01T00:00:01Z");
    store.append(id, "s1", { kind: "retry" });
    store.append(id, "s1", { kind: "running" });
    at = new Date("2026-01-01T00:00:02Z");
    store.append(id, "s1", { kind: "done" });

    expect(store.events(id)[0]?.time).toBe("2026-01-01T00:00:00.000Z");
    expect(node("s1")).toEqual({
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:02.000Z",
      retries: 1,
    });

    store.append(id, "s1", { kind: "reset" });
    expect(node("s1")).toMatchObject({ finished_at: null });

    store.append(id, "p1", { kind: "skipped" });
    store.append(id, "s1", { kind: "running" });
    store.append(id, "s1", { kind: "failed", payload: { message: "exit code 1" } });
    expect(node("p1")).toMatchObject({ finished_at: "2026-01-01T00:00:02.000Z" });
    expect(node("s1")).toMatchObject({ finished_at: "2026-01-01T00:00:02.000Z" });
  });

  it("leaves a failed append fully undone and the one before it fully done", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.append(id, "p1", { kind: "sent" });
    const db = raw();
    db.exec(
      "CREATE TRIGGER boom BEFORE UPDATE ON run_nodes BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );

    expect(() => store.append(id, "p1", { kind: "done" })).toThrow("boom");

    expect(db.prepare("SELECT node_id, kind FROM events").all()).toEqual([
      { node_id: "p1", kind: "sent" },
    ]);
    const row = db
      .prepare("SELECT started_at, finished_at FROM run_nodes WHERE node_id = 'p1'")
      .get() as { started_at: string | null; finished_at: string | null };
    expect(row.started_at).not.toBeNull();
    expect(row.finished_at).toBeNull();
  });

  it("leaves no row of a batch behind when a write in the middle of it fails", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.append(id, "p1", { kind: "sent" });
    const db = raw();
    db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.node_id = 'p2' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const rows = () => ({
      events: db.prepare("SELECT node_id, kind FROM events").all(),
      nodes: db.prepare("SELECT node_id, started_at, finished_at FROM run_nodes").all(),
    });
    const before = rows();

    expect(() =>
      store.appendAll(id, [
        { nodeId: "p1", event: { kind: "done" } },
        { nodeId: "p2", event: { kind: "sent" } },
        { nodeId: "p3", event: { kind: "sent" } },
      ]),
    ).toThrow("boom");

    expect(rows()).toEqual(before);
  });

  it("writes nothing for a run whose node rows cannot all be written", () => {
    const store = open();

    expect(() => store.createRun(newRun(["a", "a"]))).toThrow();

    const db = raw();
    expect([count(db, "runs"), count(db, "run_sessions"), count(db, "run_nodes")]).toEqual([
      0, 0, 0,
    ]);
  });

  it("rejects a raw UPDATE or DELETE on events in the database itself", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.append(id, "p1", { kind: "sent" });
    const db = raw();
    const rows = () => db.prepare("SELECT seq, node_id, kind FROM events").all();
    const before = rows();

    expect(() => db.exec("UPDATE events SET kind = 'x'")).toThrow("events are append-only");
    expect(() => db.exec("DELETE FROM events")).toThrow("events are append-only");
    expect(rows()).toEqual(before);
  });

  it("rejects an INSERT OR REPLACE over an existing event in the database itself", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.appendAll(id, [
      { nodeId: "p1", event: { kind: "sent" } },
      { nodeId: "p1", event: { kind: "done" } },
    ]);
    const db = raw();
    const rows = () => db.prepare("SELECT * FROM events ORDER BY seq").all();
    const before = rows();
    const { seq } = db.prepare("SELECT MIN(seq) AS seq FROM events").get() as { seq: number };

    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO events (seq, run_id, node_id, kind, payload, time) VALUES (?, ?, 'p1', 'failed', '\"forged\"', 'now')",
        )
        .run(seq, id),
    ).toThrow("events are append-only");
    expect(rows()).toEqual(before);
  });

  it("finds a stored run with its inputs and records how it finished", () => {
    const store = open();
    const { id } = store.createRun(newRun());

    expect(store.findRun(id)).toEqual({ ...newRun(), id, status: "running" });
    expect(store.findRun("nope")).toBeUndefined();

    store.finishRun(id, "done");

    const db = raw();
    expect(store.findRun(id)?.status).toBe("done");
    expect(db.prepare("SELECT status FROM runs").get()).toEqual({ status: "done" });
    expect(db.prepare("SELECT status FROM run_sessions").get()).toEqual({ status: "closed" });
  });

  it("reopens a finished run as running, with its session open again", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.finishRun(id, "failed");

    store.reopenRun(id);

    const db = raw();
    expect(store.findRun(id)?.status).toBe("running");
    expect(db.prepare("SELECT status FROM run_sessions").get()).toEqual({ status: "open" });
  });

  it("keeps a usage event's tokens and cost in their own columns and reads them back", () => {
    const store = open();
    const { id } = store.createRun(newRun());

    store.append(id, "p1", {
      kind: "usage",
      payload: { messages: ["m1", "m2"] },
      tokens: 1200,
      cost: 0.0042,
    });

    expect(raw().prepare("SELECT kind, tokens, cost FROM events").get()).toEqual({
      kind: "usage",
      tokens: 1200,
      cost: 0.0042,
    });
    expect(store.events(id)).toEqual([
      expect.objectContaining({
        nodeId: "p1",
        kind: "usage",
        payload: { messages: ["m1", "m2"] },
        tokens: 1200,
        cost: 0.0042,
      }),
    ]);
  });

  it("keeps each run's activity, an entry written again read back as its latest state, in id order", () => {
    const store = open();
    store.recordBuild(another("b2", "fix-signup"));
    const { id } = store.createRun(newRun());
    const other = store.createRun(newRun(["p1"], "b2")).id;
    const running = {
      id: 2,
      nodeId: "p2",
      at: 20,
      kind: "subagent" as const,
      agentType: "x",
      summary: "work",
      state: "running" as const,
    };

    store.recordActivity(id, running);
    store.recordActivity(id, {
      id: 1,
      nodeId: "p1",
      at: 10,
      kind: "tool",
      tool: "Bash",
      summary: "ls",
    });
    store.recordActivity(id, { ...running, state: "finished" });
    store.recordActivity(other, {
      id: 1,
      nodeId: "p1",
      at: 30,
      kind: "tool",
      tool: "Read",
      summary: "a",
    });

    expect(store.activity(id)).toEqual([
      { id: 1, nodeId: "p1", at: 10, kind: "tool", tool: "Bash", summary: "ls" },
      { ...running, state: "finished" },
    ]);
    expect(store.activity(other)).toHaveLength(1);
    expect(store.activity("none")).toEqual([]);
  });

  it("keeps every write of an activity entry as its own row, reading back the latest", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    const running = {
      id: 1,
      nodeId: "p1",
      at: 10,
      kind: "subagent" as const,
      agentType: "x",
      summary: "work",
      state: "running" as const,
    };

    store.recordActivity(id, running);
    store.recordActivity(id, { ...running, state: "finished" });

    expect(raw().prepare("SELECT id FROM activity ORDER BY seq").all()).toEqual([
      { id: 1 },
      { id: 1 },
    ]);
    expect(store.activity(id)).toEqual([{ ...running, state: "finished" }]);
  });

  it("skips an old output entry in a run's stored activity and reads back the rest", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    const tool: ActivityEntry = {
      id: 1,
      nodeId: "p1",
      at: 10,
      kind: "tool",
      tool: "Bash",
      summary: "ls",
    };
    const later: ActivityEntry = { ...tool, id: 3, at: 30, summary: "pwd" };
    const output = {
      id: 2,
      nodeId: "p1",
      at: 20,
      kind: "output",
      stream: "stdout",
      summary: "done",
      text: "done",
    };

    store.recordActivity(id, tool);
    raw()
      .prepare("INSERT INTO activity (run_id, id, node_id, entry) VALUES (?, ?, ?, ?)")
      .run(id, output.id, output.nodeId, JSON.stringify(output));
    store.recordActivity(id, later);

    expect(store.activity(id)).toEqual([tool, later]);
  });

  it("rejects a raw UPDATE, DELETE or INSERT OR REPLACE on activity in the database itself", () => {
    const store = open();
    const { id } = store.createRun(newRun());
    store.recordActivity(id, {
      id: 1,
      nodeId: "p1",
      at: 10,
      kind: "tool",
      tool: "Bash",
      summary: "ls",
    });
    const db = raw();
    const rows = () => db.prepare("SELECT * FROM activity ORDER BY seq").all();
    const before = rows();
    const { seq } = db.prepare("SELECT MIN(seq) AS seq FROM activity").get() as { seq: number };

    expect(() => db.exec("UPDATE activity SET entry = '{}'")).toThrow("activity is append-only");
    expect(() => db.exec("DELETE FROM activity")).toThrow("activity is append-only");
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO activity (seq, run_id, id, node_id, entry) VALUES (?, ?, 1, 'p1', '{}')",
        )
        .run(seq, id),
    ).toThrow("activity is append-only");
    expect(rows()).toEqual(before);
  });

  it("stamps a build from now", () => {
    const store = open(() => new Date("2026-01-01T00:00:00Z"));

    expect(raw().prepare("SELECT id, hash, dir, created_at FROM builds").all()).toEqual([
      {
        id: "b1",
        hash: "abc",
        dir: "/fd/workspaces/b1",
        created_at: new Date("2026-01-01T00:00:00Z").getTime(),
      },
    ]);
    expect(store.findRun(store.createRun(newRun()).id)?.buildId).toBe("b1");
  });

  describe("builds by id", () => {
    it("records one hash-equal version under two names as two builds", () => {
      const store = open();

      store.recordBuild(another("b2", "fix-signup"));

      expect(raw().prepare("SELECT id, hash, name FROM builds ORDER BY id").all()).toEqual([
        { id: "b1", hash: "abc", name: "fix-login" },
        { id: "b2", hash: "abc", name: "fix-signup" },
      ]);
    });

    it("finds a build by its id, with its name, target and values", () => {
      const store = open(() => new Date(7));

      expect(store.findBuild("b1")).toMatchObject({
        id: "b1",
        hash: "abc",
        name: "fix-login",
        repo: "/repo",
        base: "main",
        values: { ticket: "FD-1" },
        dir: "/fd/workspaces/b1",
        createdAt: 7,
      });
      expect(store.findBuild("abc")).toBeUndefined();
    });

    it("finds a build by its name", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));

      expect(store.findBuildByName("fix-signup")).toMatchObject({ id: "b2", name: "fix-signup" });
      expect(store.findBuildByName("nope")).toBeUndefined();
    });
  });

  describe("deleting a build", () => {
    it("hides the build from the list and from its name, keeping its row marked deleted", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));

      store.deleteBuild("b1");

      expect(store.listBuilds().map((each) => each.id)).toEqual(["b2"]);
      expect(store.findBuildByName("fix-login")).toBeUndefined();
      const rows = raw().prepare("SELECT id, deleted_at FROM builds ORDER BY id").all() as {
        id: string;
        deleted_at: unknown;
      }[];
      expect(rows.map((row) => row.id)).toEqual(["b1", "b2"]);
      expect(rows[0]?.deleted_at).not.toBeNull();
      expect(rows[1]?.deleted_at).toBeNull();
    });

    it("hides the deleted build's runs from the list, keeping their rows", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));
      const gone = store.createRun(newRun(["p1"]));
      store.finishRun(gone.id, "done");
      const kept = store.createRun(newRun(["p1"], "b2"));

      store.deleteBuild("b1");

      expect(store.listRuns().map((run) => run.id)).toEqual([kept.id]);
      expect(count(raw(), "runs")).toBe(2);
    });

    it("lets the name of a deleted build be used again, finding the new build by it", () => {
      const store = open();
      store.deleteBuild("b1");

      store.recordBuild(another("b3", "fix-login"));

      expect(store.findBuildByName("fix-login")).toMatchObject({ id: "b3" });
    });

    it("refuses a second build with the name of one not deleted", () => {
      const store = open();

      expect(() => store.recordBuild(another("b2", "fix-login"))).toThrow();
      expect(count(raw(), "builds")).toBe(1);
    });
  });

  describe("one running run per build", () => {
    it("refuses a second running run of a build with a BuildRunningError, writing nothing of it", () => {
      const store = open();
      store.createRun(newRun());

      expect(() => store.createRun(newRun())).toThrow(BuildRunningError);
      const db = raw();
      expect([count(db, "runs"), count(db, "run_sessions"), count(db, "run_nodes")]).toEqual([
        1, 1, 3,
      ]);
    });

    it("runs another build while the first is running", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));
      store.createRun(newRun());

      expect(store.createRun(newRun(["p1"], "b2")).status).toBe("running");
    });

    it("refuses to reopen a run while another run of its build is running, leaving it as it was", () => {
      const store = open();
      const first = store.createRun(newRun());
      store.finishRun(first.id, "stopped");
      store.createRun(newRun());

      expect(() => store.reopenRun(first.id)).toThrow(BuildRunningError);
      expect(store.findRun(first.id)?.status).toBe("stopped");
      expect(
        raw().prepare("SELECT status FROM run_sessions WHERE run_id = ?").get(first.id),
      ).toEqual({ status: "closed" });
    });
  });

  describe("stopRun", () => {
    it("marks an interrupted run stopped, so its build can run again", () => {
      const store = open();
      const interrupted = store.createRun(newRun());

      store.stopRun(interrupted.id);

      expect(store.findRun(interrupted.id)?.status).toBe("stopped");
      expect(store.createRun(newRun()).status).toBe("running");
    });

    it("leaves a run that is not running as it finished", () => {
      const store = open();
      const finished = store.createRun(newRun());
      store.finishRun(finished.id, "done");

      store.stopRun(finished.id);

      expect(store.findRun(finished.id)?.status).toBe("done");
    });
  });

  describe("listRuns", () => {
    it("lists the running run first, then the newest, with when each ended and its cost", () => {
      let now = "2026-01-01T00:00:00.000Z";
      const store = open(() => new Date(now));
      const first = store.createRun(newRun(["p1"]));
      now = "2026-01-01T00:00:05.000Z";
      store.append(first.id, "p1", { kind: "sent" });
      now = "2026-01-01T00:00:09.000Z";
      store.append(first.id, "p1", { kind: "done" });
      store.recordCost(first.id, 0.25);
      store.finishRun(first.id, "done");
      now = "2026-01-03T00:00:00.000Z";
      const third = store.createRun(newRun(["p1"]));
      store.finishRun(third.id, "stopped");
      now = "2026-01-02T00:00:00.000Z";
      const second = store.createRun(newRun(["p1", "p2"]));

      expect(store.listRuns()).toEqual([
        {
          id: second.id,
          status: "running",
          buildId: "b1",
          buildName: "fix-login",
          blueprintName: null,
          blueprintVersion: null,
          createdAt: "2026-01-02T00:00:00.000Z",
          endedAt: null,
          totalCost: null,
          nodeCount: 2,
        },
        {
          id: third.id,
          status: "stopped",
          buildId: "b1",
          buildName: "fix-login",
          blueprintName: null,
          blueprintVersion: null,
          createdAt: "2026-01-03T00:00:00.000Z",
          endedAt: null,
          totalCost: null,
          nodeCount: 1,
        },
        {
          id: first.id,
          status: "done",
          buildId: "b1",
          buildName: "fix-login",
          blueprintName: null,
          blueprintVersion: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:09.000Z",
          totalCost: 0.25,
          nodeCount: 1,
        },
      ]);
    });

    it("names the blueprint version a run's build was made from", () => {
      const db = openDatabase({ path });
      opened.push(db);
      const flows = new SqliteFlowStore({ db, newId: () => "flow-1" });
      const { version } = flows.save(flow([agent("s1")], []));
      const store = new SqliteStore({ db });
      store.recordBuild({ ...another("b2", "fix-signup"), source: { flowId: "flow-1", version } });
      const run = store.createRun(newRun(["s1"], "b2"));

      expect(store.listRuns()).toEqual([
        expect.objectContaining({ id: run.id, source: { flowId: "flow-1", version: 1 } }),
      ]);
    });
  });

  describe("pending builds", () => {
    const holdOpen = (db: Database.Database, id: string, flowId: string, name: string) =>
      db
        .prepare(
          "INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at) VALUES (?, ?, 1, ?, '{}', 1)",
        )
        .run(id, flowId, name);

    it("is busy for a second build of the same blueprint while one is open", () => {
      const store = open();
      store.startPendingBuild(pending("flow-1", "nightly"));

      expect(store.startPendingBuild(pending("flow-1", "weekly"))).toEqual({
        kind: "busy",
        reason: "blueprint",
      });
    });

    it("finds the open build of a name, and none once it has ended", () => {
      const store = open();
      const id = startedId(store, pending("flow-1", "nightly"));
      store.startPendingBuild(pending("flow-2", "weekly"));

      expect(store.findPendingBuildByName("nightly")).toMatchObject({ id, name: "nightly" });
      expect(store.findPendingBuildByName("monthly")).toBeUndefined();

      store.endPendingBuild(id, { outcome: "failed", endedAt: 2_000 });

      expect(store.findPendingBuildByName("nightly")).toBeUndefined();
    });

    it("is busy for a second build under the same name while one is open", () => {
      const store = open();
      store.startPendingBuild(pending("flow-1", "nightly"));

      expect(store.startPendingBuild(pending("flow-2", "nightly"))).toEqual({
        kind: "busy",
        reason: "name",
      });
    });

    it("reports the blueprint when both the blueprint and the name are taken", () => {
      const store = open();
      store.startPendingBuild(pending("flow-1", "weekly"));
      store.startPendingBuild(pending("flow-2", "nightly"));

      expect(store.startPendingBuild(pending("flow-1", "nightly"))).toEqual({
        kind: "busy",
        reason: "blueprint",
      });
    });

    it("maps an open row the database already holds to busy, by blueprint and by name", () => {
      const store = open();
      const db = raw();
      holdOpen(db, "held-flow", "flow-1", "held");
      holdOpen(db, "held-name", "flow-9", "nightly");

      expect(store.startPendingBuild(pending("flow-1", "weekly"))).toEqual({
        kind: "busy",
        reason: "blueprint",
      });
      expect(store.startPendingBuild(pending("flow-2", "nightly"))).toEqual({
        kind: "busy",
        reason: "name",
      });
      expect(count(db, "pending_builds")).toBe(2);
    });

    it("frees the blueprint and the name once the build ends", () => {
      const store = open();
      const first = startedId(store, pending());
      expect(store.startPendingBuild(pending()).kind).toBe("busy");

      store.endPendingBuild(first, { outcome: "failed", endedAt: 2_000 });

      const again = store.startPendingBuild(pending());
      expect(again.kind).toBe("started");
      expect(again).not.toEqual({ kind: "started", pendingId: first });
    });

    it("lists each blueprint's latest ended build with its outcome, build id and report, never an open one", () => {
      const store = open();
      const report = { version: 1, questions: [{ nodeId: "a1", text: "Which repo?" }] };
      const older = startedId(store, pending("flow-1", "first"));
      store.endPendingBuild(older, { outcome: "built", endedAt: 2_000, buildId: "b1" });
      const latest = startedId(store, pending("flow-1", "second"));
      store.endPendingBuild(latest, { outcome: "needs-you", endedAt: 3_000, report });
      const other = startedId(store, pending("flow-2", "third"));
      store.endPendingBuild(other, { outcome: "built", endedAt: 2_500, buildId: "b3" });
      startedId(store, pending("flow-1", "fourth"));
      startedId(store, pending("flow-3", "fifth"));

      expect(store.listLatestEndedPendingBuilds()).toEqual([
        expect.objectContaining({ id: other, flowId: "flow-2", outcome: "built", buildId: "b3" }),
        expect.objectContaining({
          id: latest,
          flowId: "flow-1",
          name: "second",
          outcome: "needs-you",
          endedAt: 3_000,
          report,
        }),
      ]);
    });

    it("returns build events in the order they were appended", () => {
      const store = open();
      const id = startedId(store, pending());
      const events: BuildEvent[] = [
        { type: "step", step: 1, status: "running" },
        {
          type: "session",
          name: "fd-build-1",
          claudeSessionId: "c1",
          buildId: "b1",
          repo: "/repo",
          base: "main",
          values: {},
        },
        { type: "step", step: 1, status: "done" },
      ];

      for (const event of events) store.appendBuildEvent(id, event);

      const stored = store.buildEvents(id);
      expect(stored).toEqual(events.map((event) => expect.objectContaining(event)));
      const seqs = stored.map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(3);
    });

    it("returns build activity in the order it was appended", () => {
      const store = open();
      const id = startedId(store, pending());
      const entries: ActivityEntry[] = [
        { id: 2, nodeId: "p1", at: 10, summary: "Read a.ts", kind: "tool", tool: "Read" },
        { id: 1, nodeId: "p1", at: 11, summary: "turn", kind: "turn" },
      ];

      for (const entry of entries) store.appendBuildActivity(id, entry);

      expect(store.buildActivity(id)).toEqual(entries);
    });

    it("throws when a build is ended twice", () => {
      const store = open();
      const id = startedId(store, pending());
      store.endPendingBuild(id, { outcome: "built", endedAt: 2_000, buildId: "b1" });

      expect(() => store.endPendingBuild(id, { outcome: "failed", endedAt: 3_000 })).toThrow();
    });

    it("reads one build by id: an ended one with its outcome, report and origin, an open one, and none for an unknown id", () => {
      const store = open();
      const report = { version: 1, questions: [{ nodeId: "a1", text: "Which repo?" }] };
      const origin = {
        source: { flowId: "flow-1", version: 3 },
        request: { values: { ticket: "FD-1" }, repo: "/repo", base: "main" },
      };
      const ended = startedId(store, { ...pending("flow-1", "asked"), origin });
      store.endPendingBuild(ended, { outcome: "needs-you", endedAt: 2_000, report });
      const going = startedId(store, pending("flow-2", "going"));

      expect(store.pendingBuild(ended)).toEqual({
        id: ended,
        flowId: "flow-1",
        version: 3,
        name: "asked",
        origin,
        startedAt: 1_000,
        endedAt: 2_000,
        outcome: "needs-you",
        report,
      });
      expect(store.pendingBuild(going)).toEqual({
        id: going,
        flowId: "flow-2",
        version: 3,
        name: "going",
        origin: { kind: "canvas" },
        startedAt: 1_000,
      });
      expect(store.pendingBuild("missing")).toBeNull();
    });

    it("throws when an unknown build is ended", () => {
      const store = open();

      expect(() =>
        store.endPendingBuild("missing", { outcome: "failed", endedAt: 2_000 }),
      ).toThrow();
    });

    it("keeps its rows across reopening the database", () => {
      const store = open();
      const ended = startedId(store, pending("flow-1", "nightly"));
      store.startPendingBuild(pending("flow-2", "weekly"));
      const event: BuildEvent = { type: "step", step: 1, status: "running" };
      const entry: ActivityEntry = { id: 1, nodeId: "p1", at: 10, summary: "turn", kind: "turn" };
      store.appendBuildEvent(ended, event);
      store.appendBuildActivity(ended, entry);
      store.endPendingBuild(ended, { outcome: "built", endedAt: 2_000, buildId: "b1" });
      const events = store.buildEvents(ended);
      store.close();

      const reopened = new SqliteStore({ path });
      opened.push(reopened);

      expect(reopened.buildEvents(ended)).toEqual(events);
      expect(reopened.buildActivity(ended)).toEqual([entry]);
      expect(() =>
        reopened.endPendingBuild(ended, { outcome: "failed", endedAt: 3_000 }),
      ).toThrow();
      expect(reopened.startPendingBuild(pending("flow-2", "other"))).toEqual({
        kind: "busy",
        reason: "blueprint",
      });
      expect(reopened.startPendingBuild(pending("flow-1", "nightly")).kind).toBe("started");
    });
  });
});
