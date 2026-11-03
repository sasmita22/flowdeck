import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import {
  createLibraryStore,
  selectBuildCards,
  selectRunCards,
  type LibraryBridge,
} from "../../../src/app/renderer/library-store.js";

const flows = [
  {
    flowId: "flow-a",
    name: "Report",
    createdAt: "2026-01-01T00:00:00.000Z",
    versions: 2,
    lastSavedAt: "2026-01-02T00:00:00.000Z",
    buildConfig: { repo: "/code/shop", variables: [] },
  },
];

const builds = [
  {
    id: "b-fix",
    name: "fix-login",
    old: false,
    dir: "/fd/workspaces/b-fix",
    createdAt: 6,
    source: { flowId: "flow-a", version: 2 },
  },
  {
    id: "b-idle",
    name: "docs",
    old: false,
    dir: "/fd/workspaces/b-idle",
    createdAt: 5,
    source: { flowId: "flow-a", version: 2 },
  },
  { id: "0123456789", name: null, old: true, dir: "/fd/builds/0123456789", createdAt: 4 },
];

const runs = [
  {
    id: "run-2",
    status: "interrupted",
    buildId: "b-fix",
    createdAt: "2026-01-04T00:00:00.000Z",
    endedAt: null,
    totalCost: null,
    nodeCount: 2,
    source: { flowId: "flow-a", version: 2 },
  },
  {
    id: "run-1",
    status: "done",
    buildId: "b-fix",
    createdAt: "2026-01-03T00:00:00.000Z",
    endedAt: "2026-01-03T00:01:05.000Z",
    totalCost: 0.25,
    nodeCount: 2,
    source: { flowId: "flow-a", version: 2 },
  },
];

const fakeBridge = () =>
  ({
    listFlows: vi.fn(async () => flows),
    listBuilds: vi.fn(async () => builds),
    listRuns: vi.fn(async () => runs),
    renameFlow: vi.fn(async () => null),
    buildFiles: vi.fn(async () => [
      { path: "commands/p1.md", sha256: "c", content: "do the thing" },
      { path: "manifest.json", sha256: "m", content: "{}" },
    ]),
    openFlow: vi.fn(async () => ({
      flowId: "flow-a",
      name: "Report",
      version: 2,
      flow: {
        nodes: [],
        wires: [],
        session: {
          name: "main",
          buildConfig: { variables: [] },
          model: "sonnet",
          allowedTools: [],
          permissionMode: "default",
          connectors: ["slack"],
        },
      },
    })),
    doctor: vi.fn(async () => ({ installed: [], needed: [] })),
    doctorWorktrees: vi.fn(async () => []),
    loadRun: vi.fn(async () => ({
      run: runs[1],
      name: "Report",
      flow: null,
      snapshot: { runId: "run-1", status: "done", nodes: { s1: "done" } },
      activity: [],
    })),
  }) satisfies LibraryBridge & Partial<FlowdeckBridge>;

describe("createLibraryStore", () => {
  it("loads blueprints, builds and runs together", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().refresh();

    expect(library.getState()).toMatchObject({ flows, builds, runs, loaded: true, error: null });
  });

  it("holds the error and keeps what it had when a list cannot be read", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });
    await library.getState().refresh();
    bridge.listRuns.mockRejectedValueOnce(new Error("engine exited"));

    await library.getState().refresh();

    expect(library.getState()).toMatchObject({ runs, error: "engine exited" });
  });

  it("renames a blueprint and reloads the lists, or holds the error", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await expect(library.getState().rename("flow-a", "Weekly")).resolves.toBe(true);
    expect(bridge.renameFlow).toHaveBeenCalledWith({ flowId: "flow-a", name: "Weekly" });
    expect(bridge.listFlows).toHaveBeenCalledTimes(1);

    bridge.renameFlow.mockRejectedValueOnce(new Error("A blueprint needs a name"));
    await expect(library.getState().rename("flow-a", "")).resolves.toBe(false);
    expect(library.getState().error).toBe("A blueprint needs a name");
  });

  it("opens a build's files by its id with the manifest first and shows it", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().openFiles("b-fix");

    expect(bridge.buildFiles).toHaveBeenCalledWith({ buildId: "b-fix" });
    expect(library.getState().files).toEqual({
      buildId: "b-fix",
      list: [
        { path: "manifest.json", sha256: "m", content: "{}" },
        { path: "commands/p1.md", sha256: "c", content: "do the thing" },
      ],
      selected: "manifest.json",
    });
    library.getState().selectFile("commands/p1.md");
    expect(library.getState().files?.selected).toBe("commands/p1.md");
  });

  it("checks the connectors it is given, or the ones a saved blueprint needs", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().diagnose(null, ["jira"]);
    expect(bridge.doctor).toHaveBeenLastCalledWith({ connectors: ["jira"] });
    expect(library.getState().doctor).toEqual({ installed: [], needed: [] });

    await library.getState().diagnose("flow-a", ["jira"]);
    expect(bridge.openFlow).toHaveBeenLastCalledWith({ flowId: "flow-a" });
    expect(bridge.doctor).toHaveBeenLastCalledWith({ connectors: ["slack"] });
  });
});

describe("openRun", () => {
  it("loads one run to view, and forgets it on a failed load", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().openRun("run-1");

    expect(bridge.loadRun).toHaveBeenCalledWith({ runId: "run-1" });
    expect(library.getState().viewedRun).toMatchObject({
      name: "Report",
      snapshot: { runId: "run-1", status: "done" },
    });

    bridge.loadRun.mockRejectedValueOnce(new Error("No run nope"));
    await library.getState().openRun("nope");
    expect(library.getState()).toMatchObject({ viewedRun: null, error: "No run nope" });
  });
});

describe("an interrupted run", () => {
  it("keeps the note that says why it stopped", async () => {
    const bridge = fakeBridge();
    const note = "Flowdeck closed while this run was going.";
    bridge.loadRun.mockResolvedValueOnce({
      run: { ...runs[1], status: "interrupted", endedAt: null },
      name: "Report",
      flow: null,
      snapshot: { runId: "run-1", status: "interrupted", nodes: {} },
      activity: [],
      note,
    } as never);
    const library = createLibraryStore({ bridge });

    await library.getState().openRun("run-1");

    expect(library.getState().viewedRun?.note).toBe(note);
  });
});

describe("cards", () => {
  it("keys each build by its id, names it, marks an old one, and gives it its latest run", async () => {
    const library = createLibraryStore({ bridge: fakeBridge() });
    await library.getState().refresh();

    expect(selectBuildCards(library.getState())).toEqual([
      {
        id: "b-fix",
        name: "fix-login",
        blueprint: "Report",
        version: 2,
        createdAt: 6,
        flowId: "flow-a",
        old: false,
        run: { id: "run-2", status: "interrupted" },
      },
      {
        id: "b-idle",
        name: "docs",
        blueprint: "Report",
        version: 2,
        createdAt: 5,
        flowId: "flow-a",
        old: false,
        run: null,
      },
      {
        id: "0123456789",
        name: "Not from a blueprint",
        blueprint: "Not from a blueprint",
        version: null,
        createdAt: 4,
        flowId: null,
        old: true,
        run: null,
      },
    ]);
  });

  it("names each run's blueprint and version", async () => {
    const library = createLibraryStore({ bridge: fakeBridge() });
    await library.getState().refresh();

    expect(selectRunCards(library.getState())).toEqual([
      expect.objectContaining({ id: "run-2", name: "Report", version: 2, buildId: "b-fix" }),
      expect.objectContaining({ id: "run-1", name: "Report", version: 2, buildId: "b-fix" }),
    ]);
  });
});
