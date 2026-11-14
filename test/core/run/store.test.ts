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
  values: { ticket: "FD-1" },
  dir: `/fd/workspaces/${id}`,
  files: [],
  nodes: [],
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

  return (): Store => {
    const now = () => new Date(deletedAtTime);
    if (kind === "fake") return new FakeStore({ now });
    const store = new SqliteStore({ path: join(folder, "flowdeck.db"), now });
    opened.push(store);
    return store;
  };
};

describe.each(kinds)("%s listBuildsWithDeleted", (_name, kind) => {
  const open = withStores(kind);

  it("returns live and deleted builds, with deletedAt set only on the deleted ones", () => {
    const store = open();
    store.recordBuild(build("live1234", "keep"));
    store.recordBuild(build("gone1234", "gone"));
    store.deleteBuild("gone1234");

    const listed = store.listBuildsWithDeleted();

    expect(listed.map(({ id }) => id).sort()).toEqual(["gone1234", "live1234"]);
    expect(listed.find(({ id }) => id === "live1234")).toMatchObject({
      name: "keep",
      deletedAt: null,
    });
    expect(listed.find(({ id }) => id === "gone1234")).toMatchObject({
      name: "gone",
      deletedAt: deletedAtTime,
    });
  });

  it("leaves listBuilds without the deleted builds", () => {
    const store = open();
    store.recordBuild(build("live1234", "keep"));
    store.recordBuild(build("gone1234", "gone"));
    store.deleteBuild("gone1234");

    expect(store.listBuilds().map(({ id }) => id)).toEqual(["live1234"]);
  });
});

const savedFlow = flow([agent("a1"), agent("a2")], [thenWire("a1", "a2")]);

const snapshot = (blueprintName = "Report", version = 2): NewBuildSnapshot => ({
  blueprintName,
  version,
  flow: savedFlow,
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

  it("still reads a build's snapshot once the build is deleted", () => {
    const store = open();
    store.recordBuild(build("b1", "fix-login"));
    const locked = started(store, pending("fix-login", "flow-1", { snapshot: snapshot() }));
    store.endPendingBuild(locked, { outcome: "built", endedAt: 2_000, buildId: "b1" });

    store.deleteBuild("b1");

    expect(store.buildSnapshot({ buildId: "b1" })).toEqual({
      ...snapshot(),
      pendingId: locked,
      buildId: "b1",
    });
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

    it("lists a deleted build", () => {
      const store = open();
      store.recordBuild({ ...build("gone1", "gone"), source: { flowId: "flow-9", version: 4 } });
      store.deleteBuild("gone1");

      expect(store.listSnapshotGaps()).toEqual([
        { pendingId: null, buildId: "gone1", flowId: "flow-9", version: 4, blueprintName: null },
      ]);
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
    it("lists builds with their snapshot's blueprint name and version, and nulls without one, deleted builds included", () => {
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

      store.deleteBuild("b1");

      expect(store.listBuildsWithDeleted()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "b1", blueprintName: "Report", blueprintVersion: 3 }),
        ]),
      );
    });

    it("lists runs with their build's name and its snapshot's blueprint name and version", () => {
      const store = open();
      store.recordBuild(build("b1", "fix-login"));
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
