import Database from "better-sqlite3";
import { access, copyFile, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { nodeStatus, type RunEvent } from "../../../src/core/run/run-events.js";
import { BuildRunningError, type RunStory } from "../../../src/core/run/store.js";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import type { BuildEvent } from "../../../src/core/run/build-progress.js";
import type { RepoState } from "../../../src/core/run/repo-state.js";
import type { NewBuild, NewPendingBuild, NewRun } from "../../../src/ports/store.js";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { agent, flow } from "../../fixtures/flow-builders.js";
import { FakeStore } from "../../fakes/fake-store.js";

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
  branch: "flowdeck/fix-login",
  branchCreated: true,
  values: { ticket: "FD-1" },
  dir: "/fd/workspaces/b1",
  files: [],
  nodes: [],
  manifest: "{}",
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

const activityOf = (id: number): ActivityEntry => ({
  id,
  nodeId: "p1",
  at: 10,
  kind: "tool",
  tool: "Bash",
  summary: "ls",
});

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
      { name: "012_drop_pending_builds_one_per_flow.sql" },
      { name: "013_flows_deleted_at.sql" },
      { name: "014_build_branch.sql" },
      { name: "015_build_manifests.sql" },
      { name: "016_events_by_node.sql" },
      { name: "017_run_stories.sql" },
      { name: "018_runs_deleted_at.sql" },
      { name: "019_runs_own_their_build.sql" },
      { name: "020_run_repo_states_and_step_texts.sql" },
      { name: "021_complete_deletes_and_build_texts.sql" },
      { name: "022_clean_start.sql" },
      { name: "023_containers_clean_start.sql" },
      { name: "024_build_worktrees_clean_start.sql" },
    ]);
    expect(counts()).toEqual(before);
    expect(before).toEqual([1, 1, 3, 1, 24]);
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

    expect(store.findRun(id)).toEqual({
      ...newRun(),
      id,
      status: "running",
      buildName: "fix-login",
      buildHash: "abc",
      blueprintName: null,
      repo: "/repo",
      branch: "flowdeck/fix-login",
      buildValues: { ticket: "FD-1" },
      manifestJson: "{}",
    });
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

  describe("run stories", () => {
    const story = (runId: string, text: string, runStatus: RunStory["runStatus"] = "failed") => ({
      runId,
      at: "2026-11-15T10:00:00.000Z",
      runStatus,
      text,
      cost: 0.0007,
    });

    it("reads back the latest story of a run, the second append for it being the latest", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      store.finishRun(id, "failed");
      const other = store.createRun(newRun(["p1"]));
      const first = story(id, "The run failed at Test.");
      const second = { ...story(id, "Resumed, the run finished.", "done"), cost: 0.0009 };

      store.appendRunStory(first);
      expect(store.latestRunStory(id)).toEqual(first);

      store.appendRunStory(second);
      expect(store.latestRunStory(id)).toEqual(second);
      expect(store.latestRunStory(other.id)).toBeUndefined();
    });

    it("rejects a raw UPDATE, DELETE or INSERT OR REPLACE on run_stories in the database itself", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      store.finishRun(id, "failed");
      store.appendRunStory(story(id, "The run failed at Test."));
      const db = raw();
      const rows = () => db.prepare("SELECT * FROM run_stories ORDER BY seq").all();
      const before = rows();
      const { seq } = db.prepare("SELECT MIN(seq) AS seq FROM run_stories").get() as {
        seq: number;
      };

      expect(() => db.exec("UPDATE run_stories SET text = 'edited'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM run_stories")).toThrow(/append-only/);
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO run_stories (seq, run_id, at, run_status, text, cost) VALUES (?, ?, 'now', 'done', 'replaced', 0)",
          )
          .run(seq, id),
      ).toThrow(/append-only/);
      expect(rows()).toEqual(before);
    });

    it("lists a run with the first non-empty line of its latest story, and one without a story with none", () => {
      const store = open();
      const told = store.createRun(newRun(["p1"]));
      store.finishRun(told.id, "failed");
      const untold = store.createRun(newRun(["p1"]));
      store.finishRun(untold.id, "done");
      store.appendRunStory(story(told.id, "Old account.\nStill old."));
      store.appendRunStory(story(told.id, "\nThe run failed at Test.\nThe suite did not pass."));

      const listed = new Map(store.listRuns().map((run) => [run.id, run]));

      expect(listed.get(told.id)?.storyLine).toBe("The run failed at Test.");
      expect(store.findRunSummary(told.id)?.storyLine).toBe("The run failed at Test.");
      expect(listed.get(untold.id)).not.toHaveProperty("storyLine");
      expect(store.findRunSummary(untold.id)).not.toHaveProperty("storyLine");
    });

    it("lists a run whose story has Context, Goal and Result with the first line of its Result", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      store.finishRun(id, "failed");
      store.appendRunStory(
        story(
          id,
          [
            "Context: Repo shop on branch main; the tests were failing before.",
            "Goal: Fix the login bug and run the test suite.",
            "Result: The run failed at Test.",
            "The suite did not pass.",
          ].join("\n"),
        ),
      );

      expect(store.listRuns().find((run) => run.id === id)?.storyLine).toBe(
        "The run failed at Test.",
      );
      expect(store.findRunSummary(id)?.storyLine).toBe("The run failed at Test.");
    });
  });

  describe("repo states", () => {
    const state = (head: string): Extract<RepoState, { kind: "read" }> => ({
      kind: "read",
      branch: "flowdeck/fix-login",
      head,
      upstream: { name: "origin/main", ahead: 1, behind: 0 },
      staged: 0,
      unstaged: 2,
      untracked: 1,
    });

    it("reads the first before, the latest after and that after's other repos", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      store.finishRun(id, "done");
      const other = store.createRun(newRun(["p1"]));

      store.appendRepoState(id, "before", state("b1"), []);
      store.appendRepoState(id, "after", state("a1"), [{ path: "/x/web", branch: "dev" }]);
      store.appendRepoState(id, "before", state("b2"), []);
      store.appendRepoState(id, "after", { kind: "unreadable" }, [
        { path: "/x/ios", branch: "develop" },
      ]);
      store.appendRepoState(other.id, "after", state("o1"), []);

      expect(store.repoStates(id)).toEqual({
        before: state("b1"),
        after: { kind: "unreadable" },
        otherRepos: [{ path: "/x/ios", branch: "develop" }],
      });
    });

    it("reads nothing for a run with no rows", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));

      expect(store.repoStates(id)).toEqual({ before: null, after: null, otherRepos: [] });
    });

    it("keeps another repo's before out of the run's own, and lists it merged with the after of the same repo, sorted by path", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      const web = { ...state("w1"), branch: "dev" };

      store.appendOtherRepoBefore(id, "/x/web", web);
      store.appendRepoState(id, "before", state("b1"), []);
      store.appendOtherRepoBefore(id, "/x/web", state("w2"));
      store.appendOtherRepoBefore(id, "/x/api", { ...state("p1"), branch: null });
      store.appendOtherRepoBefore(id, "/x/old", { kind: "unreadable" });
      store.appendRepoState(id, "after", state("a1"), [
        { path: "/x/web", branch: "dev", after: state("w3") },
        { path: "/x/ios", branch: "develop" },
      ]);

      expect(store.repoStates(id)).toEqual({
        before: state("b1"),
        after: state("a1"),
        otherRepos: [
          { path: "/x/api", branch: "detached p1", before: { ...state("p1"), branch: null } },
          { path: "/x/ios", branch: "develop" },
          { path: "/x/old", branch: "not recorded", before: { kind: "unreadable" } },
          { path: "/x/web", branch: "dev", before: web, after: state("w3") },
        ],
      });
    });

    it("lists another repo's before while the run has no after yet", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));

      store.appendOtherRepoBefore(id, "/x/web", state("w1"));

      expect(store.repoStates(id)).toEqual({
        before: null,
        after: null,
        otherRepos: [{ path: "/x/web", branch: "flowdeck/fix-login", before: state("w1") }],
      });
    });

    it("reads a stored state that no longer fits the schema as unreadable and bad other repos as none", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      const db = raw();
      const insert = db.prepare(
        "INSERT INTO run_repo_states (run_id, phase, state_json, other_repos_json, at) VALUES (?, ?, ?, ?, 0)",
      );
      insert.run(id, "before", JSON.stringify({ kind: "read", staged: -1 }), "[]");
      insert.run(id, "after", "{not json", JSON.stringify([{ path: 1 }]));

      expect(store.repoStates(id)).toEqual({
        before: { kind: "unreadable" },
        after: { kind: "unreadable" },
        otherRepos: [],
      });
    });

    it("rejects a raw UPDATE, DELETE or INSERT OR REPLACE on run_repo_states", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      store.appendRepoState(id, "before", state("b1"), []);
      const db = raw();
      const rows = () => db.prepare("SELECT * FROM run_repo_states ORDER BY id").all();
      const before = rows();
      const { rowId } = db.prepare("SELECT MIN(id) AS rowId FROM run_repo_states").get() as {
        rowId: number;
      };

      expect(() => db.exec("UPDATE run_repo_states SET state_json = '{}'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM run_repo_states")).toThrow(/append-only/);
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO run_repo_states (id, run_id, phase, state_json, other_repos_json, at) VALUES (?, ?, 'after', '{}', '[]', 0)",
          )
          .run(rowId, id),
      ).toThrow(/append-only/);
      expect(rows()).toEqual(before);
    });
  });

  describe("step texts", () => {
    it("reads the latest full text per field of one entry", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      const large = "x".repeat(5 * 1024 * 1024);

      store.appendStepText(id, 1, "input", "old input");
      store.appendStepText(id, 1, "output", large);
      store.appendStepText(id, 1, "input", "new input");
      store.appendStepText(id, 2, "report", "another entry");

      const texts = store.stepTexts(id, 1);
      expect(texts).toHaveLength(2);
      expect(texts).toEqual(
        expect.arrayContaining([
          { field: "input", text: "new input" },
          { field: "output", text: large },
        ]),
      );
      expect(store.stepTexts(id, 2)).toEqual([{ field: "report", text: "another entry" }]);
    });

    it("reads nothing for an unknown run or entry", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      store.appendStepText(id, 1, "input", "text");

      expect(store.stepTexts("nope", 1)).toEqual([]);
      expect(store.stepTexts(id, 9)).toEqual([]);
    });

    it("rejects a raw UPDATE, DELETE or INSERT OR REPLACE on step_texts", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1"]));
      store.appendStepText(id, 1, "input", "text");
      const db = raw();
      const rows = () => db.prepare("SELECT * FROM step_texts ORDER BY id").all();
      const before = rows();
      const { rowId } = db.prepare("SELECT MIN(id) AS rowId FROM step_texts").get() as {
        rowId: number;
      };

      expect(() => db.exec("UPDATE step_texts SET text = 'edited'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM step_texts")).toThrow(/append-only/);
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO step_texts (id, run_id, entry_id, field, text, at) VALUES (?, ?, 1, 'input', 'replaced', 0)",
          )
          .run(rowId, id),
      ).toThrow(/append-only/);
      expect(rows()).toEqual(before);
    });
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

    it.each([
      ["a new branch it made", "flowdeck/fix-signup", true],
      ["an existing branch", "feat-y", false],
    ])("reads back the branch of a build on %s", (_name, branch, branchCreated) => {
      const store = open();

      store.recordBuild({ ...another("b2", "fix-signup"), branch, branchCreated });

      expect(store.findBuild("b2")).toMatchObject({ branch, branchCreated });
    });

    it("finds a build by its name", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));

      expect(store.findBuildByName("fix-signup")).toMatchObject({ id: "b2", name: "fix-signup" });
      expect(store.findBuildByName("nope")).toBeUndefined();
    });
  });

  describe("deleting a build", () => {
    it("hides the build from the list and from its name, and removes its row", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));

      store.deleteBuild("b1");

      expect(store.listBuilds().map((each) => each.id)).toEqual(["b2"]);
      expect(store.findBuildByName("fix-login")).toBeUndefined();
      expect(raw().prepare("SELECT id FROM builds ORDER BY id").all()).toEqual([{ id: "b2" }]);
    });

    it("keeps listing the deleted build's runs, marked deleted", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));
      const gone = store.createRun(newRun(["p1"]));
      store.finishRun(gone.id, "done");
      const kept = store.createRun(newRun(["p1"], "b2"));

      store.deleteBuild("b1");

      expect(store.listRuns().map(({ id, buildGone }) => ({ id, buildGone }))).toEqual([
        { id: kept.id, buildGone: false },
        { id: gone.id, buildGone: true },
      ]);
      expect(count(raw(), "runs")).toBe(2);
    });

    it("lets the name of a deleted build be used again, finding the new build by it", () => {
      const store = open();
      store.deleteBuild("b1");

      store.recordBuild(another("b3", "fix-login"));

      expect(store.findBuildByName("fix-login")).toMatchObject({ id: "b3" });
    });

    it("removes the build's step texts, its run number count and the older ended attempts of its name, keeping its runs", () => {
      const store = open();
      const older = startedId(store, { ...pending("flow-1", "fix-login"), startedAt: 100 });
      store.endPendingBuild(older, { outcome: "failed", endedAt: 200 });
      const other = startedId(store, { ...pending("flow-1", "nightly"), startedAt: 100 });
      store.endPendingBuild(other, { outcome: "failed", endedAt: 200 });
      const built = startedId(store, pending("flow-1", "fix-login"));
      store.appendBuildStepText(built, 1, "output", "full");
      store.endPendingBuild(built, { outcome: "built", endedAt: 2_000, buildId: "b1" });
      const run = store.createRun(newRun(["p1"]));
      store.finishRun(run.id, "done");

      store.deleteBuild("b1");

      const db = raw();
      expect(count(db, "build_step_texts")).toBe(0);
      expect(db.prepare("SELECT build_id FROM run_number_counters").pluck().all()).toEqual([]);
      expect(store.pendingBuild(older)).toBeNull();
      expect(store.pendingBuild(other)).toMatchObject({ id: other });
      expect(store.findRun(run.id)).toMatchObject({ id: run.id, buildId: "b1" });
    });

    it("refuses a second build with the name of one not deleted", () => {
      const store = open();

      expect(() => store.recordBuild(another("b2", "fix-login"))).toThrow();
      expect(count(raw(), "builds")).toBe(1);
    });
  });

  describe("build worktrees", () => {
    const android = {
      container: "android",
      repo: "/repos/android",
      base: "main",
      branch: "fix-login-android",
      branchCreated: true,
      path: "/fd/workspaces/b1/sessions/android/android",
    };
    const ios = {
      container: "ios",
      repo: "/repos/ios",
      base: "develop",
      branch: "fix-login-ios",
      branchCreated: true,
      path: "/fd/workspaces/b1/sessions/ios/ios",
    };
    const existingBranch = {
      container: "main",
      repo: "/repo",
      base: "main",
      branch: "feature/signup",
      branchCreated: false,
      path: "/fd/workspaces/b2/sessions/main/repo",
    };

    it("lists every worktree added for a build, in the order added", () => {
      const store = open();

      store.addBuildWorktree("b1", android);
      store.addBuildWorktree("b1", ios);

      expect(store.buildWorktrees("b1")).toEqual([android, ios]);
    });

    it("removes a build's worktrees with the build, keeping another build's", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));
      store.addBuildWorktree("b1", android);
      store.addBuildWorktree("b1", ios);
      store.addBuildWorktree("b2", existingBranch);

      store.deleteBuild("b1");

      expect(store.buildWorktrees("b1")).toEqual([]);
      expect(store.buildWorktrees("b2")).toEqual([existingBranch]);
    });

    it("removes the worktrees of a build that was never recorded when its pending build is deleted, keeping another build's", () => {
      const store = open();
      store.addBuildWorktree("b2", existingBranch);
      const gone = startedId(store, pending("flow-1", "nightly"));
      store.appendBuildEvent(gone, {
        type: "session",
        name: "fd-build-nightly",
        claudeSessionId: "claude-1",
        buildId: "b1",
        repo: "",
        base: "",
        values: {},
      });
      store.addBuildWorktree("b1", android);
      store.addBuildWorktree("b1", ios);
      store.endPendingBuild(gone, { outcome: "failed", endedAt: 2_000 });

      store.deletePendingBuild(gone);

      expect(store.buildWorktrees("b1")).toEqual([]);
      expect(store.buildWorktrees("b2")).toEqual([existingBranch]);
    });

    it("migrating a database at 023 empties builds and runs, keeps blueprints, and adds the table", async () => {
      const allMigrations = fileURLToPath(
        new URL("../../../src/adapters/sqlite/migrations/", import.meta.url),
      );
      const to023 = join(folder, "to-023");
      await mkdir(to023);
      for (const file of (await readdir(allMigrations)).filter((each) => each < "024")) {
        await copyFile(join(allMigrations, file), join(to023, file));
      }
      const old = openDatabase({ path, migrationsDir: to023 });
      new SqliteFlowStore({ db: old, newId: () => "flow-1" }).save(flow([agent("s1")], []));
      const oldStore = new SqliteStore({ db: old });
      oldStore.recordBuild(build);
      oldStore.createRun(newRun());
      old.close();

      const store = new SqliteStore({ path });
      opened.push(store);

      const db = raw();
      expect(["builds", "runs", "flows", "flow_versions"].map((t) => count(db, t))).toEqual([
        0, 0, 1, 1,
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'build_worktrees'",
          )
          .pluck()
          .get(),
      ).toBe("build_worktrees");
      expect(store.buildWorktrees("b1")).toEqual([]);
    });
  });

  describe("deleting a run", () => {
    const threeFinishedRuns = (store: SqliteStore): [string, string, string] => {
      const finished = () => {
        const run = store.createRun(newRun(["p1"]));
        store.finishRun(run.id, "done");
        return run.id;
      };
      return [finished(), finished(), finished()];
    };

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

    const withRowsEverywhere = (store: SqliteStore, runId: string) => {
      store.append(runId, "p1", { kind: "sent" });
      store.recordActivity(runId, activityOf(1));
      store.appendRunStory({ runId, at: "t", runStatus: "done", text: "Told.", cost: 0 });
      store.appendRepoState(runId, "before", { kind: "unreadable" }, []);
      store.appendOtherRepoBefore(runId, "/x/web", { kind: "unreadable" });
      store.appendStepText(runId, 1, "output", "full");
    };

    const rowsOf = (runId: string) =>
      Object.fromEntries(
        runTables.map(([table, column]) => [
          table,
          (
            raw().prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(runId) as {
              n: number;
            }
          ).n,
        ]),
      );

    it("removes every row of the run from every run table and hides it from listRuns, keeping the others", () => {
      const store = open();
      const [first, second] = threeFinishedRuns(store);
      withRowsEverywhere(store, first);
      withRowsEverywhere(store, second);
      const kept = rowsOf(first);

      store.deleteRun(second);

      expect(store.listRuns().map((run) => run.id)).not.toContain(second);
      expect(store.listRuns().map((run) => run.id)).toContain(first);
      expect(rowsOf(second)).toEqual(Object.fromEntries(runTables.map(([table]) => [table, 0])));
      expect(rowsOf(first)).toEqual(kept);
      expect(Object.values(kept).every((n) => n > 0)).toBe(true);
    });

    it("still refuses a raw DELETE of a live run's activity once another run is deleted", () => {
      const store = open();
      const [first, second] = threeFinishedRuns(store);
      withRowsEverywhere(store, first);
      store.deleteRun(second);
      const db = raw();

      expect(() => db.prepare("DELETE FROM activity WHERE run_id = ?").run(first)).toThrow(
        /append-only/,
      );
      expect(rowsOf(first).activity).toBe(1);
    });

    it("keeps the numbers of the build's other runs", () => {
      const store = open();
      const [first, second, third] = threeFinishedRuns(store);

      store.deleteRun(second);

      const numberOf = new Map(store.listRuns().map((run) => [run.id, run.number]));
      expect([numberOf.get(first), numberOf.get(third)]).toEqual([1, 3]);
    });

    it("finds nothing for the deleted run by id", () => {
      const store = open();
      const [, second] = threeFinishedRuns(store);

      store.deleteRun(second);

      expect(store.findRun(second)).toBeUndefined();
      expect(store.findRunSummary(second)).toBeUndefined();
    });

    it("does nothing when the run is deleted again", () => {
      const store = open();
      const [first, second] = threeFinishedRuns(store);
      store.deleteRun(second);
      const listed = store.listRuns();

      store.deleteRun(second);

      expect(store.listRuns()).toEqual(listed);
      expect(store.findRun(first)).toBeDefined();
    });

    it("never gives a deleted top run's number to the build's next run", () => {
      const store = open();
      const [, , third] = threeFinishedRuns(store);
      store.deleteRun(third);

      const next = store.createRun(newRun(["p1"]));

      expect(store.findRunSummary(next.id)).toMatchObject({ number: 4 });
    });
  });

  describe("deleting a pending build", () => {
    const pendingTables = [
      ["build_activity", "pending_id"],
      ["build_events", "pending_id"],
      ["build_snapshots", "pending_id"],
      ["build_step_texts", "pending_id"],
      ["pending_builds", "id"],
    ] as const;

    const snapshot = { blueprintName: "Nightly", version: 3, svg: "<svg/>" };

    const withBuildRows = (store: SqliteStore, build: NewPendingBuild) => {
      const id = startedId(store, { ...build, snapshot });
      store.appendBuildEvent(id, { type: "step", step: 1, status: "running" });
      store.appendBuildActivity(id, activityOf(1));
      store.appendBuildStepText(id, 1, "output", "full");
      return id;
    };

    const pendingRowsOf = (id: string) =>
      Object.fromEntries(
        pendingTables.map(([table, column]) => [
          table,
          (
            raw().prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as {
              n: number;
            }
          ).n,
        ]),
      );

    const none = Object.fromEntries(pendingTables.map(([table]) => [table, 0]));

    it("removes an open build and every row of it, hiding it from listPendingBuilds", () => {
      const store = open();
      const gone = withBuildRows(store, pending("flow-1", "nightly"));
      const kept = withBuildRows(store, pending("flow-2", "weekly"));

      store.deletePendingBuild(gone);

      expect(store.listPendingBuilds().map((each) => each.id)).toEqual([kept]);
      expect(pendingRowsOf(gone)).toEqual(none);
      expect(Object.values(pendingRowsOf(kept)).every((n) => n === 1)).toBe(true);
    });

    it("removes an ended build, hiding it from listLatestEndedPendingBuildsByName", () => {
      const store = open();
      const gone = withBuildRows(store, pending("flow-1", "first"));
      store.endPendingBuild(gone, { outcome: "failed", endedAt: 2_000 });
      const kept = startedId(store, pending("flow-1", "second"));
      store.endPendingBuild(kept, { outcome: "failed", endedAt: 3_000 });

      store.deletePendingBuild(gone);

      expect(store.listLatestEndedPendingBuildsByName().map((each) => each.id)).toEqual([kept]);
      expect(pendingRowsOf(gone)).toEqual(none);
    });

    it("does not bring back an older ended build of the name once the latest is hidden", () => {
      const store = open();
      const older = withBuildRows(store, pending("flow-1", "nightly"));
      store.endPendingBuild(older, { outcome: "failed", endedAt: 2_000 });
      const latest = startedId(store, pending("flow-1", "nightly"));
      store.endPendingBuild(latest, { outcome: "needs-you", endedAt: 3_000 });

      store.deletePendingBuild(latest);

      expect(store.listLatestEndedPendingBuildsByName()).toEqual([]);
      expect(pendingRowsOf(older)).toEqual(none);
    });

    it("leaves a going build of the name, started earlier, as it is", () => {
      const store = open();
      const older = startedId(store, { ...pending("flow-1", "nightly"), startedAt: 100 });
      store.endPendingBuild(older, { outcome: "failed", endedAt: 200 });
      const latest = startedId(store, pending("flow-1", "nightly"));
      store.endPendingBuild(latest, { outcome: "failed", endedAt: 2_000 });
      const going = withBuildRows(store, { ...pending("flow-1", "nightly"), startedAt: 500 });

      store.deletePendingBuild(latest);

      expect(store.pendingBuild(older)).toBeNull();
      expect(store.listPendingBuilds().map((each) => each.id)).toEqual([going]);
      expect(Object.values(pendingRowsOf(going)).every((n) => n === 1)).toBe(true);
    });

    it("does nothing when the build is deleted again", () => {
      const store = open();
      const id = startedId(store, pending());
      store.endPendingBuild(id, { outcome: "failed", endedAt: 2_000 });
      store.deletePendingBuild(id);

      store.deletePendingBuild(id);

      expect(store.pendingBuild(id)).toBeNull();
      expect(pendingRowsOf(id)).toEqual(none);
    });
  });

  describe("build step texts", () => {
    it("reads back the latest text per field of one entry in the order they were written", () => {
      const store = open();
      const id = startedId(store, pending());
      const other = startedId(store, pending("flow-2", "weekly"));

      store.appendBuildStepText(id, 1, "output", "old output");
      store.appendBuildStepText(id, 1, "input", "input");
      store.appendBuildStepText(id, 1, "output", "new output");
      store.appendBuildStepText(id, 2, "report", "another entry");
      store.appendBuildStepText(other, 1, "output", "another build");

      expect(store.buildStepTexts(id, 1)).toEqual([
        { field: "input", text: "input" },
        { field: "output", text: "new output" },
      ]);
      expect(store.buildStepTexts(id, 2)).toEqual([{ field: "report", text: "another entry" }]);
      expect(store.buildStepTexts("nope", 1)).toEqual([]);
    });

    it("rejects a raw UPDATE on build_step_texts", () => {
      const store = open();
      const id = startedId(store, pending());
      store.appendBuildStepText(id, 1, "output", "full");

      expect(() => raw().exec("UPDATE build_step_texts SET text = 'edited'")).toThrow(
        /append-only/,
      );
      expect(store.buildStepTexts(id, 1)).toEqual([{ field: "output", text: "full" }]);
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
          buildGone: false,
          number: 3,
          doneCount: 0,
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
          buildGone: false,
          number: 2,
          doneCount: 0,
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
          buildGone: false,
          number: 1,
          doneCount: 1,
        },
      ]);
    });

    it("numbers each build's runs from 1 in the order they were made", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));
      const made: { id: string; buildId: string }[] = [];
      for (const buildId of ["b1", "b2", "b1", "b2", "b1"]) {
        const run = store.createRun(newRun(["p1"], buildId));
        store.finishRun(run.id, "done");
        made.push({ id: run.id, buildId });
      }

      const numberOf = new Map(store.listRuns().map((run) => [run.id, run.number]));

      expect(made.map(({ id, buildId }) => [buildId, numberOf.get(id)])).toEqual([
        ["b1", 1],
        ["b2", 1],
        ["b1", 2],
        ["b2", 2],
        ["b1", 3],
      ]);
    });

    it("counts only the nodes whose latest state is done", () => {
      const store = open();
      const { id } = store.createRun(newRun(["done", "failed", "skipped", "reset", "untouched"]));
      store.append(id, "done", { kind: "running" });
      store.append(id, "done", { kind: "done" });
      store.append(id, "done", {
        kind: "usage",
        payload: { messages: [] },
        tokens: 1,
        cost: 0.01,
      });
      store.append(id, "failed", { kind: "running" });
      store.append(id, "failed", { kind: "failed", payload: { message: "exit code 1" } });
      store.append(id, "skipped", { kind: "skipped" });
      store.append(id, "reset", { kind: "done" });
      store.append(id, "reset", { kind: "reset" });

      expect(store.listRuns()).toEqual([
        expect.objectContaining({ id, doneCount: 1, nodeCount: 5 }),
      ]);
    });

    it("counts done nodes as the fake does after every kind of event", () => {
      const oneOfEach: { [K in RunEvent["kind"]]: RunEvent & { kind: K } } = {
        sent: { kind: "sent" },
        running: { kind: "running" },
        retry: { kind: "retry" },
        "needs-you": { kind: "needs-you" },
        skipped: { kind: "skipped" },
        reset: { kind: "reset" },
        done: { kind: "done" },
        failed: { kind: "failed", payload: { message: "exit code 1" } },
        decided: { kind: "decided", payload: { nodeId: "decided", decision: "approved" } },
        answered: {
          kind: "answered",
          payload: { nodeId: "answered", decision: "answered", answer: "yes" },
        },
        round: { kind: "round", payload: { round: 1 } },
        usage: { kind: "usage", payload: { messages: [] }, tokens: 1, cost: 0.01 },
        compacted: { kind: "compacted", payload: { tokens: 1 } },
      };
      const nodeIds = Object.keys(oneOfEach);
      const sqlite = open();
      const fake = new FakeStore();
      const doneCounts = [sqlite, fake].map((store) => {
        const { id } = store.createRun(newRun(nodeIds));
        for (const [nodeId, event] of Object.entries(oneOfEach)) {
          store.append(id, nodeId, { kind: "done" });
          store.append(id, nodeId, event);
        }
        return store.findRunSummary(id)?.doneCount;
      });

      expect(doneCounts).toEqual([6, 6]);
    });

    it("counts no done nodes for a run with no events", () => {
      const store = open();
      const { id } = store.createRun(newRun(["p1", "p2"]));

      expect(store.findRunSummary(id)).toMatchObject({ doneCount: 0, nodeCount: 2 });
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

  describe("findRunSummary", () => {
    it("summarises one run as listRuns does, and nothing for an unknown id", () => {
      const store = open();
      const first = store.createRun(newRun(["p1"]));
      store.append(first.id, "p1", { kind: "done" });
      store.recordCost(first.id, 0.25);
      store.finishRun(first.id, "done");
      store.createRun(newRun(["p1", "p2"]));

      expect(store.findRunSummary(first.id)).toEqual(
        store.listRuns().find((run) => run.id === first.id),
      );
      expect(store.findRunSummary("nope")).toBeUndefined();
    });

    it("finds a run of a deleted build, marked deleted, as listRuns lists it", () => {
      const store = open();
      const gone = store.createRun(newRun(["p1"]));
      store.finishRun(gone.id, "failed");

      store.deleteBuild("b1");

      expect(store.findRunSummary(gone.id)).toMatchObject({
        id: gone.id,
        status: "failed",
        buildId: "b1",
        buildName: "fix-login",
        nodeCount: 1,
        buildGone: true,
      });
      expect(store.listRuns()).toEqual([store.findRunSummary(gone.id)]);
    });

    it("gives one run its number among all its build's runs", () => {
      const store = open();
      store.recordBuild(another("b2", "fix-signup"));
      for (const buildId of ["b1", "b2", "b1"]) {
        store.finishRun(store.createRun(newRun(["p1"], buildId)).id, "done");
      }
      const third = store.createRun(newRun(["p1"]));

      expect(store.findRunSummary(third.id)).toMatchObject({ number: 3 });
    });
  });

  describe("pending builds", () => {
    const holdOpen = (db: Database.Database, id: string, flowId: string, name: string) =>
      db
        .prepare(
          "INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at) VALUES (?, ?, 1, ?, '{}', 1)",
        )
        .run(id, flowId, name);

    it("starts a second build of the same blueprint under another name while one is open", () => {
      const store = open();
      const first = startedId(store, pending("flow-1", "nightly"));

      const second = store.startPendingBuild(pending("flow-1", "weekly"));

      expect(second).toEqual({ kind: "started", pendingId: expect.stringMatching(uuid) });
      expect(second).not.toEqual({ kind: "started", pendingId: first });
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

    it("reports the name when a blueprint with an open build is built again under a taken name", () => {
      const store = open();
      store.startPendingBuild(pending("flow-1", "weekly"));
      store.startPendingBuild(pending("flow-2", "nightly"));

      expect(store.startPendingBuild(pending("flow-1", "nightly"))).toEqual({
        kind: "busy",
        reason: "name",
      });
    });

    it("starts beside an open row the database already holds for the blueprint, and maps one holding the name to busy", () => {
      const store = open();
      const db = raw();
      holdOpen(db, "held-flow", "flow-1", "held");
      holdOpen(db, "held-name", "flow-9", "nightly");

      expect(store.startPendingBuild(pending("flow-1", "weekly")).kind).toBe("started");
      expect(store.startPendingBuild(pending("flow-2", "nightly"))).toEqual({
        kind: "busy",
        reason: "name",
      });
      expect(count(db, "pending_builds")).toBe(3);
    });

    it("frees the name once the build ends", () => {
      const store = open();
      const first = startedId(store, pending());
      expect(store.startPendingBuild(pending()).kind).toBe("busy");

      store.endPendingBuild(first, { outcome: "failed", endedAt: 2_000 });

      const again = store.startPendingBuild(pending());
      expect(again.kind).toBe("started");
      expect(again).not.toEqual({ kind: "started", pendingId: first });
    });

    it("lists each name's latest ended build with its outcome and report, dropping a name that ended built, never an open one", () => {
      const store = open();
      const report = { version: 1, questions: [{ nodeId: "a1", text: "Which repo?" }] };
      const first = startedId(store, pending("flow-1", "first"));
      store.endPendingBuild(first, { outcome: "failed", endedAt: 2_000 });
      const second = startedId(store, pending("flow-1", "second"));
      store.endPendingBuild(second, { outcome: "needs-you", endedAt: 3_000, report });
      const olderThird = startedId(store, pending("flow-2", "third"));
      store.endPendingBuild(olderThird, { outcome: "failed", endedAt: 2_200 });
      const third = startedId(store, pending("flow-2", "third"));
      store.endPendingBuild(third, { outcome: "built", endedAt: 2_500, buildId: "b3" });
      startedId(store, pending("flow-1", "fourth"));
      startedId(store, pending("flow-3", "fifth"));

      expect(store.listLatestEndedPendingBuildsByName()).toEqual([
        expect.objectContaining({ id: first, flowId: "flow-1", name: "first", outcome: "failed" }),
        expect.objectContaining({
          id: second,
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
      expect(reopened.startPendingBuild(pending("flow-2", "weekly"))).toEqual({
        kind: "busy",
        reason: "name",
      });
      expect(reopened.startPendingBuild(pending("flow-2", "other")).kind).toBe("started");
      expect(reopened.startPendingBuild(pending("flow-1", "nightly")).kind).toBe("started");
    });
  });
});
