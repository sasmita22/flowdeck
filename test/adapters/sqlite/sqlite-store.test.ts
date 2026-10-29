import Database from "better-sqlite3";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import type { NewRun } from "../../../src/ports/store.js";

const newRun = (nodeIds = ["p1", "p2", "p3"]): NewRun => ({
  buildDir: "/fd/builds/abc",
  inputs: { cwd: "/repo", auto: true },
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("SqliteStore", () => {
  let folder: string;
  let path: string;
  const opened: { close(): void }[] = [];

  const open = (now?: () => Date) => {
    const store = new SqliteStore(now === undefined ? { path } : { path, now });
    opened.push(store);
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

    open();

    expect(tables).toEqual(expect.arrayContaining(["runs", "run_sessions", "run_nodes", "events"]));
    expect(db.prepare("SELECT name FROM migrations ORDER BY name").all()).toEqual([
      { name: "001_runs.sql" },
      { name: "002_flows.sql" },
    ]);
    expect(counts()).toEqual(before);
    expect(before).toEqual([1, 1, 3, 1, 2]);
  });

  it("writes one run, one session and one row per node", () => {
    const { id } = open().createRun(newRun());
    const db = raw();

    expect(id).toMatch(uuid);
    expect(db.prepare("SELECT id, status, build_dir FROM runs").all()).toEqual([
      { id, status: "running", build_dir: "/fd/builds/abc" },
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
});
