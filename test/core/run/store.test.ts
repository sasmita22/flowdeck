import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { flowSvg } from "../../../src/core/flow/flow-svg.js";
import type {
  NewBuild,
  NewBuildSnapshot,
  NewPendingBuild,
  NewRun,
  Store,
} from "../../../src/core/run/store.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { agent, flow, thenWire } from "../../fixtures/flow-builders.js";

const build = (id: string, name: string): NewBuild => ({
  id,
  hash: `hash-${id}`,
  name,
  repo: "/repos/app",
  base: "main",
  branch: `flowdeck/${name}`,
  branchCreated: true,
  values: { ticket: "FD-1" },
  dir: `/fd/workspaces/${id}`,
  files: [],
  nodes: [],
  manifest: `{"version":1,"hash":"hash-${id}"}`,
});

const deletedAtTime = Date.UTC(2026, 0, 2);

const kinds = [
  ["SqliteStore", "sqlite"],
  ["FakeStore", "fake"],
] as const;

const withStores = (kind: (typeof kinds)[number][1]) => {
  let folder: string;
  let opened: SqliteStore[];

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-store-"));
    opened = [];
  });

  afterEach(async () => {
    for (const store of opened) store.close();
    await rm(folder, { recursive: true, force: true });
  });

  const path = () => join(folder, "flowdeck.db");

  const open = (): Store => {
    const now = () => new Date(deletedAtTime);
    if (kind === "fake") return new FakeStore({ now });
    const store = new SqliteStore({ path: path(), now });
    opened.push(store);
    return store;
  };

  return Object.assign(open, { path });
};

describe.each(kinds)("%s listBuilds", (_name, kind) => {
  const open = withStores(kind);

  it("returns the live builds only, a deleted build being gone", () => {
    const store = open();
    store.recordBuild(build("live1234", "keep"));
    store.recordBuild(build("gone1234", "gone"));
    store.deleteBuild("gone1234");

    const listed = store.listBuilds();

    expect(listed.map(({ id }) => id)).toEqual(["live1234"]);
    expect(listed[0]).toMatchObject({ name: "keep", deletedAt: null });
  });
});

const savedFlow = flow([agent("a1"), agent("a2")], [thenWire("a1", "a2")]);

const snapshot = (blueprintName = "Report", version = 2): NewBuildSnapshot => ({
  blueprintName,
  version,
  svg: flowSvg(savedFlow),
});

const pending = (
  name: string,
  flowId: string,
  options: { snapshot?: NewBuildSnapshot; blueprintName?: string } = {},
): NewPendingBuild => ({
  flowId,
  version: 2,
  name,
  origin: {
    source: { flowId, version: 2 },
    blueprint: { name: options.blueprintName ?? "Report", version: 2 },
  },
  startedAt: 1_000,
  ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
});

const started = (store: Store, request: NewPendingBuild): string => {
  const start = store.startPendingBuild(request);
  if (start.kind !== "started") throw new Error(`expected a start, got ${start.reason}`);
  return start.pendingId;
};

const run = (buildId: string): NewRun => ({
  buildDir: `/fd/workspaces/${buildId}`,
  inputs: {},
  nodeIds: ["a1"],
  session: { tmuxName: "fd-run", cwd: "/repos/app", claudeSessionId: "c1" },
  buildId,
});

describe.each(kinds)("%s build snapshots", (_name, kind) => {
  const open = withStores(kind);

  it("keeps the snapshot a pending build starts with, and none for one started without", () => {
    const store = open();
    const withSnapshot = started(store, pending("nightly", "flow-1", { snapshot: snapshot() }));
    const without = started(store, pending("weekly", "flow-2"));

    expect(store.buildSnapshot({ pendingId: withSnapshot })).toEqual({
      ...snapshot(),
      pendingId: withSnapshot,
      buildId: null,
    });
    expect(store.buildSnapshot({ pendingId: without })).toBeNull();
    expect(store.buildSnapshot({ buildId: "nope" })).toBeNull();
  });

  it("gives the snapshot the build id its pending build locks with, and none to one ended without", () => {
    const store = open();
    const locked = started(store, pending("nightly", "flow-1", { snapshot: snapshot() }));
    const failed = started(store, pending("weekly", "flow-2", { snapshot: snapshot("Weekly") }));

    store.endPendingBuild(locked, { outcome: "built", endedAt: 2_000, buildId: "b1" });
    store.endPendingBuild(failed, { outcome: "failed", endedAt: 2_000 });

    const linked = { ...snapshot(), pendingId: locked, buildId: "b1" };
    expect(store.buildSnapshot({ buildId: "b1" })).toEqual(linked);
    expect(store.buildSnapshot({ pendingId: locked })).toEqual(linked);
    expect(store.buildSnapshot({ pendingId: failed })).toMatchObject({
      blueprintName: "Weekly",
      buildId: null,
    });
  });

  it("keeps the flow a snapshot froze, read by pending id and then by build id", () => {
    const store = open();
    const frozen = flow([{ ...agent("a1"), label: "Planner" }], []);
    const locked = started(
      store,
      pending("nightly", "flow-1", { snapshot: { ...snapshot(), flow: frozen } }),
    );

    expect(store.buildSnapshot({ pendingId: locked })?.flow).toEqual(frozen);
    store.endPendingBuild(locked, { outcome: "built", endedAt: 2_000, buildId: "b1" });
    expect(store.buildSnapshot({ buildId: "b1" })?.flow).toEqual(frozen);
  });

  it("reads no flow from a snapshot written without one", () => {
    const store = open();
    const locked = started(store, pending("nightly", "flow-1", { snapshot: snapshot() }));

    expect(store.buildSnapshot({ pendingId: locked })).not.toHaveProperty("flow");
  });

  it("reads no snapshot of a build once the build is deleted", () => {
    const store = open();
    store.recordBuild(build("b1", "fix-login"));
    const locked = started(store, pending("fix-login", "flow-1", { snapshot: snapshot() }));
    store.endPendingBuild(locked, { outcome: "built", endedAt: 2_000, buildId: "b1" });

    store.deleteBuild("b1");

    expect(store.buildSnapshot({ buildId: "b1" })).toBeNull();
    expect(store.buildSnapshot({ pendingId: locked })).toBeNull();
  });

  describe("listSnapshotGaps", () => {
    it("lists a pending build with no snapshot, named from its origin, then a recorded build with no pending row", () => {
      const store = open();
      store.recordBuild({ ...build("old1", "old"), source: { flowId: "flow-9", version: 4 } });
      const open1 = started(store, pending("nightly", "flow-1", { blueprintName: "Nightly" }));
      started(store, pending("weekly", "flow-2", { snapshot: snapshot() }));

      expect(store.listSnapshotGaps()).toEqual([
        { pendingId: open1, buildId: null, flowId: "flow-1", version: 2, blueprintName: "Nightly" },
        { pendingId: null, buildId: "old1", flowId: "flow-9", version: 4, blueprintName: null },
      ]);
    });

    it("lists a build made from no saved version with no flow or version", () => {
      const store = open();
      store.recordBuild(build("bare1", "bare"));

      expect(store.listSnapshotGaps()).toEqual([
        { pendingId: null, buildId: "bare1", flowId: null, version: null, blueprintName: null },
      ]);
    });

    it("lists neither once each has a snapshot", () => {
      const store = open();
      store.recordBuild({ ...build("old1", "old"), source: { flowId: "flow-9", version: 4 } });
      const open1 = started(store, pending("nightly", "flow-1"));

      store.addSnapshotIfMissing({ pendingId: open1, buildId: null }, snapshot());
      store.addSnapshotIfMissing({ pendingId: null, buildId: "old1" }, snapshot());

      expect(store.listSnapshotGaps()).toEqual([]);
    });

    it("does not list a deleted build", () => {
      const store = open();
      store.recordBuild({ ...build("gone1", "gone"), source: { flowId: "flow-9", version: 4 } });
      store.deleteBuild("gone1");

      expect(store.listSnapshotGaps()).toEqual([]);
    });

    it("leaves out a recorded build while its pending build of the same name is open, and lists it once that ends without a snapshot", () => {
      const store = open();
      const going = started(store, pending("fix-login", "flow-1"));
      store.addSnapshotIfMissing({ pendingId: going, buildId: null }, snapshot());
      const bare = started(store, pending("nightly", "flow-2"));
      store.recordBuild({ ...build("b1", "fix-login"), source: { flowId: "flow-1", version: 2 } });
      store.recordBuild({ ...build("b2", "nightly"), source: { flowId: "flow-2", version: 2 } });

      expect(store.listSnapshotGaps()).toEqual([
        { pendingId: bare, buildId: null, flowId: "flow-2", version: 2, blueprintName: "Report" },
      ]);

      store.endPendingBuild(going, { outcome: "built", endedAt: 2_000, buildId: "b1" });
      store.endPendingBuild(bare, { outcome: "built", endedAt: 2_000, buildId: "b2" });

      expect(store.listSnapshotGaps()).toEqual([
        { pendingId: bare, buildId: "b2", flowId: "flow-2", version: 2, blueprintName: "Report" },
        { pendingId: null, buildId: "b2", flowId: "flow-2", version: 2, blueprintName: null },
      ]);
    });

    it("carries the build id of an ended pending build", () => {
      const store = open();
      const locked = started(store, pending("nightly", "flow-1"));
      store.endPendingBuild(locked, { outcome: "built", endedAt: 2_000, buildId: "b1" });

      expect(store.listSnapshotGaps()).toEqual([
        { pendingId: locked, buildId: "b1", flowId: "flow-1", version: 2, blueprintName: "Report" },
      ]);
    });
  });

  describe("addSnapshotIfMissing", () => {
    it("adds a pending build's snapshot once, keeping the first", () => {
      const store = open();
      const id = started(store, pending("nightly", "flow-1"));

      expect(store.addSnapshotIfMissing({ pendingId: id, buildId: null }, snapshot("First"))).toBe(
        true,
      );
      expect(store.addSnapshotIfMissing({ pendingId: id, buildId: null }, snapshot("Second"))).toBe(
        false,
      );
      expect(store.buildSnapshot({ pendingId: id })).toEqual({
        ...snapshot("First"),
        pendingId: id,
        buildId: null,
      });
    });

    it("adds a build's snapshot once, keeping the first", () => {
      const store = open();
      store.recordBuild(build("b1", "fix-login"));

      expect(
        store.addSnapshotIfMissing({ pendingId: null, buildId: "b1" }, snapshot("First")),
      ).toBe(true);
      expect(
        store.addSnapshotIfMissing({ pendingId: null, buildId: "b1" }, snapshot("Second")),
      ).toBe(false);
      expect(store.buildSnapshot({ buildId: "b1" })).toEqual({
        ...snapshot("First"),
        pendingId: null,
        buildId: "b1",
      });
    });

    it("adds one snapshot under both keys of a locked pending build", () => {
      const store = open();
      const locked = started(store, pending("nightly", "flow-1"));
      store.endPendingBuild(locked, { outcome: "built", endedAt: 2_000, buildId: "b1" });

      expect(store.addSnapshotIfMissing({ pendingId: locked, buildId: "b1" }, snapshot())).toBe(
        true,
      );

      const both = { ...snapshot(), pendingId: locked, buildId: "b1" };
      expect(store.buildSnapshot({ pendingId: locked })).toEqual(both);
      expect(store.buildSnapshot({ buildId: "b1" })).toEqual(both);
    });

    it("adds nothing when the build id of the gap already has a snapshot", () => {
      const store = open();
      const locked = started(store, pending("nightly", "flow-1"));
      store.endPendingBuild(locked, { outcome: "built", endedAt: 2_000, buildId: "b1" });
      store.addSnapshotIfMissing({ pendingId: null, buildId: "b1" }, snapshot("By build"));

      expect(
        store.addSnapshotIfMissing({ pendingId: locked, buildId: "b1" }, snapshot("By pending")),
      ).toBe(false);
      expect(store.buildSnapshot({ pendingId: locked })).toBeNull();
      expect(store.buildSnapshot({ buildId: "b1" })).toMatchObject({ blueprintName: "By build" });
    });

    it("adds nothing when the pending id of the gap already has a snapshot", () => {
      const store = open();
      const id = started(store, pending("nightly", "flow-1", { snapshot: snapshot("Started") }));

      expect(store.addSnapshotIfMissing({ pendingId: id, buildId: "b9" }, snapshot("Later"))).toBe(
        false,
      );
      expect(store.buildSnapshot({ buildId: "b9" })).toBeNull();
      expect(store.buildSnapshot({ pendingId: id })).toMatchObject({ blueprintName: "Started" });
    });
  });

  describe("listings", () => {
    it("lists builds with their snapshot's blueprint name and version, and nulls without one", () => {
      const store = open();
      store.recordBuild(build("b1", "fix-login"));
      store.recordBuild(build("b2", "fix-signup"));
      store.addSnapshotIfMissing({ pendingId: null, buildId: "b1" }, snapshot("Report", 3));

      expect(store.listBuilds()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "b1", blueprintName: "Report", blueprintVersion: 3 }),
          expect.objectContaining({ id: "b2", blueprintName: null, blueprintVersion: null }),
        ]),
      );
    });

    it("lists runs with their build's name and its snapshot's blueprint name and version", () => {
      const store = open();
      store.recordBuild({ ...build("b1", "fix-login"), source: { flowId: "flow-1", version: 3 } });
      store.recordBuild(build("b2", "fix-signup"));
      store.addSnapshotIfMissing({ pendingId: null, buildId: "b1" }, snapshot("Report", 3));
      const snapped = store.createRun(run("b1"));
      const bare = store.createRun(run("b2"));

      const listed = store.listRuns();

      expect(listed.find(({ id }) => id === snapped.id)).toMatchObject({
        buildName: "fix-login",
        blueprintName: "Report",
        blueprintVersion: 3,
      });
      expect(listed.find(({ id }) => id === bare.id)).toMatchObject({
        buildName: "fix-signup",
        blueprintName: null,
        blueprintVersion: null,
      });
    });
  });
});

describe.each(kinds)("%s concurrent builds of one blueprint", (_name, kind) => {
  const open = withStores(kind);

  it("starts a second open build of a blueprint under another name, and refuses the same name", () => {
    const store = open();
    started(store, pending("fix-a", "flow-1"));

    expect(store.startPendingBuild(pending("fix-b", "flow-1"))).toEqual({
      kind: "started",
      pendingId: expect.any(String),
    });
    expect(store.startPendingBuild(pending("fix-a", "flow-1"))).toEqual({
      kind: "busy",
      reason: "name",
    });
  });
});

describe.each(kinds)("%s latest ended pending build per build name", (_name, kind) => {
  const open = withStores(kind);

  const ended = (
    store: Store,
    name: string,
    flowId: string,
    end: Parameters<Store["endPendingBuild"]>[1],
  ): string => {
    const id = started(store, pending(name, flowId));
    store.endPendingBuild(id, end);
    return id;
  };

  it("lists two ended builds of one blueprint under different names", () => {
    const store = open();
    const a = ended(store, "fix-a", "flow-1", { outcome: "failed", endedAt: 2_000 });
    const b = ended(store, "fix-b", "flow-1", { outcome: "failed", endedAt: 3_000 });

    expect(store.listLatestEndedPendingBuildsByName().map(({ id }) => id)).toEqual([a, b]);
  });

  it("keeps only the newer of two failed builds of one name", () => {
    const store = open();
    ended(store, "fix-a", "flow-1", { outcome: "failed", endedAt: 2_000 });
    const newer = ended(store, "fix-a", "flow-1", { outcome: "failed", endedAt: 3_000 });

    expect(store.listLatestEndedPendingBuildsByName()).toEqual([
      expect.objectContaining({ id: newer, name: "fix-a", outcome: "failed", endedAt: 3_000 }),
    ]);
  });

  it("lists nothing for a name whose latest ended build is built", () => {
    const store = open();
    ended(store, "fix-a", "flow-1", { outcome: "failed", endedAt: 2_000 });
    ended(store, "fix-a", "flow-1", { outcome: "built", endedAt: 3_000, buildId: "b1" });
    const other = ended(store, "fix-b", "flow-2", { outcome: "failed", endedAt: 2_500 });

    expect(store.listLatestEndedPendingBuildsByName().map(({ id }) => id)).toEqual([other]);
  });

  it("lists stopped and needs-you builds with their outcome and report", () => {
    const store = open();
    const report = { version: 1, questions: [{ nodeId: "a1", text: "Which repo?" }] };
    const stopped = ended(store, "fix-a", "flow-1", { outcome: "stopped", endedAt: 2_000 });
    const asked = ended(store, "fix-b", "flow-1", {
      outcome: "needs-you",
      endedAt: 3_000,
      report,
    });

    expect(store.listLatestEndedPendingBuildsByName()).toEqual([
      expect.objectContaining({ id: stopped, outcome: "stopped" }),
      expect.objectContaining({ id: asked, outcome: "needs-you", report }),
    ]);
  });

  it("returns no open build, even one sharing a name with an ended build", () => {
    const store = open();
    const failed = ended(store, "fix-a", "flow-1", { outcome: "failed", endedAt: 2_000 });
    started(store, pending("fix-a", "flow-1"));
    started(store, pending("fix-b", "flow-2"));

    expect(store.listLatestEndedPendingBuildsByName().map(({ id }) => id)).toEqual([failed]);
  });
});

describe.each(kinds)("%s deleting a build keeps its runs", (_name, kind) => {
  const open = withStores(kind);

  const recorded = (store: Store, id: string, name: string, flowId: string) => {
    store.recordBuild({
      ...build(id, name),
      source: { flowId, version: 3 },
      files: [{ path: "flow.json", sha256: `sha-${id}` }],
      nodes: [{ nodeId: "a1", type: "agent", config: {} }],
    });
    const pendingId = started(store, {
      ...pending(name, flowId, { snapshot: snapshot("Report", 3) }),
      version: 3,
    });
    store.appendBuildEvent(pendingId, { type: "step", step: 1, status: "done" });
    store.appendBuildActivity(pendingId, {
      id: 1,
      nodeId: "a1",
      at: 1_500,
      summary: "Read flow.json",
      kind: "tool",
      tool: "Read",
    });
    store.endPendingBuild(pendingId, { outcome: "built", endedAt: 2_000, buildId: id });
    return pendingId;
  };

  const finished = (store: Store, buildId: string) => {
    const created = store.createRun(run(buildId));
    store.finishRun(created.id, "done");
    return created.id;
  };

  const rowsNaming = (buildId: string, pendingId: string) => {
    const db = new Database(open.path(), { readonly: true });
    try {
      const count = (sql: string, id: string) => (db.prepare(sql).get(id) as { n: number }).n;
      return {
        builds: count("SELECT count(*) AS n FROM builds WHERE id = ?", buildId),
        ...Object.fromEntries(
          [
            "build_files",
            "build_nodes",
            "build_manifests",
            "build_snapshots",
            "pending_builds",
          ].map((table) => [
            table,
            count(`SELECT count(*) AS n FROM ${table} WHERE build_id = ?`, buildId),
          ]),
        ),
        ...Object.fromEntries(
          ["build_events", "build_activity"].map((table) => [
            table,
            count(`SELECT count(*) AS n FROM ${table} WHERE pending_id = ?`, pendingId),
          ]),
        ),
      };
    } finally {
      db.close();
    }
  };

  const noRows = {
    builds: 0,
    build_files: 0,
    build_nodes: 0,
    build_manifests: 0,
    build_snapshots: 0,
    pending_builds: 0,
    build_events: 0,
    build_activity: 0,
  };

  it("still returns each run of the deleted build with its name, blueprint, version and number, and buildGone", () => {
    const store = open();
    recorded(store, "b1", "fix-login", "flow-1");
    const first = finished(store, "b1");
    const second = finished(store, "b1");
    const before = [first, second].map((id) => ({
      id,
      record: store.findRun(id),
      summary: store.findRunSummary(id),
    }));
    expect(before.map(({ summary }) => summary)).toEqual([
      expect.objectContaining({
        buildName: "fix-login",
        blueprintName: "Report",
        blueprintVersion: 3,
        source: { flowId: "flow-1", version: 3 },
        number: 1,
        buildGone: false,
      }),
      expect.objectContaining({ number: 2, buildGone: false }),
    ]);

    store.deleteBuild("b1");

    for (const { id, record, summary } of before) {
      const gone = { ...summary, buildGone: true };
      expect(store.findRun(id)).toEqual(record);
      expect(store.findRunSummary(id)).toEqual(gone);
      expect(store.listRuns().find((listed) => listed.id === id)).toEqual(gone);
    }
  });

  it("keeps the build's name, blueprint and source on the run's record once the build is deleted", () => {
    const store = open();
    recorded(store, "b1", "fix-login", "flow-1");
    const runId = finished(store, "b1");

    store.deleteBuild("b1");

    expect(store.findRun(runId)).toMatchObject({
      buildName: "fix-login",
      blueprintName: "Report",
      source: { flowId: "flow-1", version: 3 },
    });
  });

  it("leaves nothing of the deleted build, its events and activity included", () => {
    const store = open();
    const pendingId = recorded(store, "b1", "fix-login", "flow-1");
    finished(store, "b1");

    store.deleteBuild("b1");

    expect(store.findBuild("b1")).toBeUndefined();
    expect(store.listBuilds().map(({ id }) => id)).not.toContain("b1");
    expect(store.buildFiles("b1")).toEqual([]);
    expect(store.buildManifest("b1")).toBeUndefined();
    expect(store.buildSnapshot({ buildId: "b1" })).toBeNull();
    expect(store.buildSnapshot({ pendingId })).toBeNull();
    expect(store.pendingBuild(pendingId)).toBeNull();
    expect(store.buildEvents(pendingId)).toEqual([]);
    expect(store.buildActivity(pendingId)).toEqual([]);
    if (kind === "sqlite") expect(rowsNaming("b1", pendingId)).toEqual(noRows);
  });

  it("leaves a second build and its runs untouched", () => {
    const store = open();
    recorded(store, "b1", "fix-login", "flow-1");
    finished(store, "b1");
    const keptPending = recorded(store, "b2", "fix-signup", "flow-2");
    const kept = finished(store, "b2");
    const keptBuild = store.findBuild("b2");
    const keptSummary = store.findRunSummary(kept);
    const keptEvents = store.buildEvents(keptPending);
    const keptActivity = store.buildActivity(keptPending);

    store.deleteBuild("b1");

    expect(store.findBuild("b2")).toEqual(keptBuild);
    expect(store.findRunSummary(kept)).toEqual({ ...keptSummary, buildGone: false });
    expect(store.buildFiles("b2")).toEqual([{ path: "flow.json", sha256: "sha-b2" }]);
    expect(store.buildManifest("b2")).toBe(build("b2", "fix-signup").manifest);
    expect(store.buildSnapshot({ buildId: "b2" })).toMatchObject({ blueprintName: "Report" });
    expect(store.pendingBuild(keptPending)).not.toBeNull();
    expect(store.buildEvents(keptPending)).toEqual(keptEvents);
    expect(store.buildActivity(keptPending)).toEqual(keptActivity);
    expect(keptEvents).toHaveLength(1);
    expect(keptActivity).toHaveLength(1);
  });
});
