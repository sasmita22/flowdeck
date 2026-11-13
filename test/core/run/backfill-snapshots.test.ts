import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { flowSvg } from "../../../src/core/flow/flow-svg.js";
import { backfillSnapshots } from "../../../src/core/run/backfill-snapshots.js";
import type { FlowStore } from "../../../src/ports/flow-store.js";
import type { BuildSource, NewBuild, Store } from "../../../src/ports/store.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { agent, flow } from "../../fixtures/flow-builders.js";

const savedFlow = flow([agent("a1")], []);

const newBuild = (id: string, source?: BuildSource): NewBuild => ({
  id,
  hash: `hash-${id}`,
  name: `name-${id}`,
  repo: "/repo",
  base: "main",
  values: {},
  dir: `/fd/workspaces/${id}`,
  ...(source === undefined ? {} : { source }),
  files: [],
  nodes: [],
});

const startPending = (store: Store, flowId: string, version: number, name: string) => {
  const start = store.startPendingBuild({
    flowId,
    version,
    name,
    origin: { source: { flowId, version }, blueprint: { name: "Report", version } },
    startedAt: 1_000,
  });
  if (start.kind !== "started") throw new Error(`expected a start, got ${start.reason}`);
  return start.pendingId;
};

const savedReport = (flows: FlowStore) => flows.save(savedFlow, { name: "Report" });

describe("backfillSnapshots", () => {
  let store: FakeStore;
  let flows: FakeFlowStore;

  beforeEach(() => {
    store = new FakeStore();
    flows = new FakeFlowStore();
  });

  it("gives an old build from a saved version one snapshot named after the blueprint now", () => {
    const { flowId, version } = savedReport(flows);
    flows.rename(flowId, "Report renamed");
    store.recordBuild(newBuild("b1", { flowId, version }));

    expect(backfillSnapshots({ store, flows })).toEqual({ added: 1, failures: [] });

    expect(store.buildSnapshot({ buildId: "b1" })).toEqual({
      pendingId: null,
      buildId: "b1",
      blueprintName: "Report renamed",
      version,
      flow: savedFlow,
      svg: flowSvg(savedFlow),
    });
  });

  it("gives an ended needs-you build a snapshot keyed by its pending id, named from its origin", () => {
    const { flowId, version } = savedReport(flows);
    const pendingId = startPending(store, flowId, version, "fix-login");
    store.endPendingBuild(pendingId, { outcome: "needs-you", endedAt: 2_000 });
    flows.rename(flowId, "Report renamed");

    expect(backfillSnapshots({ store, flows })).toEqual({ added: 1, failures: [] });

    expect(store.buildSnapshot({ pendingId })).toEqual({
      pendingId,
      buildId: null,
      blueprintName: "Report",
      version,
      flow: savedFlow,
      svg: flowSvg(savedFlow),
    });
  });

  it("gives a locked pending build one snapshot carrying its pending id and build id", () => {
    const { flowId, version } = savedReport(flows);
    const pendingId = startPending(store, flowId, version, "fix-login");
    store.recordBuild(newBuild("b1", { flowId, version }));
    store.endPendingBuild(pendingId, { outcome: "built", endedAt: 2_000, buildId: "b1" });

    expect(backfillSnapshots({ store, flows })).toEqual({ added: 1, failures: [] });

    const snapshot = store.buildSnapshot({ pendingId });
    expect(snapshot).toMatchObject({ pendingId, buildId: "b1", blueprintName: "Report" });
    expect(store.buildSnapshot({ buildId: "b1" })).toEqual(snapshot);
  });

  it("writes nothing for a flow-less build or a pending build from a file", () => {
    store.recordBuild(newBuild("b1"));
    const pendingId = startPending(store, "file:/tmp/flow.json", 1, "from-file");

    expect(backfillSnapshots({ store, flows })).toEqual({ added: 0, failures: [] });

    expect(store.buildSnapshot({ buildId: "b1" })).toBeNull();
    expect(store.buildSnapshot({ pendingId })).toBeNull();
  });

  it("skips a build whose version the flow store cannot load", () => {
    const { flowId } = savedReport(flows);
    store.recordBuild(newBuild("b1", { flowId, version: 9 }));

    expect(backfillSnapshots({ store, flows })).toEqual({ added: 0, failures: [] });

    expect(store.buildSnapshot({ buildId: "b1" })).toBeNull();
  });

  it("reports a gap whose blueprint cannot be read and still fills the gaps after it", () => {
    const broken = flows.save(savedFlow, { name: "Broken" });
    const { flowId, version } = savedReport(flows);
    store.recordBuild(newBuild("b-broken", broken));
    store.recordBuild(newBuild("b-ok", { flowId, version }));
    const unreadable = new Error("bad flow json");
    const load = flows.load.bind(flows);
    vi.spyOn(flows, "load").mockImplementation((ref) => {
      if (ref.flowId === broken.flowId) throw unreadable;
      return load(ref);
    });

    expect(backfillSnapshots({ store, flows })).toEqual({
      added: 1,
      failures: [{ gap: expect.objectContaining({ buildId: "b-broken" }), error: unreadable }],
    });

    expect(store.buildSnapshot({ buildId: "b-broken" })).toBeNull();
    expect(store.buildSnapshot({ buildId: "b-ok" })).toMatchObject({ blueprintName: "Report" });
  });

  it("adds nothing on a second call", () => {
    const { flowId, version } = savedReport(flows);
    store.recordBuild(newBuild("b1", { flowId, version }));
    backfillSnapshots({ store, flows });
    const first = store.buildSnapshot({ buildId: "b1" });
    flows.rename(flowId, "Report renamed");

    expect(backfillSnapshots({ store, flows })).toEqual({ added: 0, failures: [] });

    expect(store.buildSnapshot({ buildId: "b1" })).toEqual(first);
  });
});

describe("backfillSnapshots on SQLite", () => {
  let folder: string;
  const opened: { close(): void }[] = [];

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-backfill-"));
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("fills each gap once from the blueprints in the same database", () => {
    const db = openDatabase({ path: join(folder, "flowdeck.db") });
    opened.push(db);
    const store = new SqliteStore({ db });
    const flows = new SqliteFlowStore({ db });
    const { flowId, version } = savedReport(flows);
    store.recordBuild(newBuild("old", { flowId, version }));
    const pendingId = startPending(store, flowId, version, "fix-login");
    store.recordBuild(newBuild("locked", { flowId, version }));
    store.endPendingBuild(pendingId, { outcome: "built", endedAt: 2_000, buildId: "locked" });
    store.recordBuild(newBuild("flowless"));

    expect(backfillSnapshots({ store, flows })).toEqual({ added: 2, failures: [] });
    expect(backfillSnapshots({ store, flows })).toEqual({ added: 0, failures: [] });

    expect(store.buildSnapshot({ buildId: "old" })).toEqual({
      pendingId: null,
      buildId: "old",
      blueprintName: "Report",
      version,
      flow: savedFlow,
      svg: flowSvg(savedFlow),
    });
    expect(store.buildSnapshot({ buildId: "locked" })).toMatchObject({ pendingId });
    expect(store.buildSnapshot({ buildId: "flowless" })).toBeNull();
  });
});
