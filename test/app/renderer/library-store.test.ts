import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import {
  createLibraryStore,
  pinnedFirst,
  selectBuildCards,
  selectPicture,
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
    pinned: false,
  },
];

const builds = [
  {
    id: "b-fix",
    name: "fix-login",
    old: false,
    dir: "/fd/workspaces/b-fix",
    createdAt: 7,
    source: { flowId: "flow-a", version: 2 },
    blueprintName: "Old report",
    blueprintVersion: 2,
  },
  {
    id: "b-idle",
    name: null,
    old: false,
    dir: "/fd/workspaces/b-idle",
    createdAt: 6,
    source: { flowId: "flow-a", version: 2 },
    blueprintName: "Old report",
    blueprintVersion: 2,
  },
  {
    id: "b-gap",
    name: null,
    old: false,
    dir: "/fd/workspaces/b-gap",
    createdAt: 5,
    source: { flowId: "flow-a", version: 1 },
    blueprintName: null,
    blueprintVersion: null,
  },
  {
    id: "0123456789",
    name: null,
    old: true,
    dir: "/fd/builds/0123456789",
    createdAt: 4,
    blueprintName: null,
    blueprintVersion: null,
  },
];

const fromFixLogin = {
  buildId: "b-fix",
  source: { flowId: "flow-a", version: 2 },
  buildName: "fix-login",
  blueprintName: "Old report",
  blueprintVersion: 2,
};

const runs = [
  {
    id: "run-2",
    status: "interrupted",
    createdAt: "2026-01-04T00:00:00.000Z",
    endedAt: null,
    totalCost: null,
    nodeCount: 2,
    ...fromFixLogin,
  },
  {
    id: "run-1",
    status: "done",
    createdAt: "2026-01-03T00:00:00.000Z",
    endedAt: "2026-01-03T00:01:05.000Z",
    totalCost: 0.25,
    nodeCount: 2,
    ...fromFixLogin,
  },
  {
    id: "run-idle",
    status: "done",
    buildId: "b-idle",
    createdAt: "2026-01-02T00:00:00.000Z",
    endedAt: "2026-01-02T00:01:00.000Z",
    totalCost: null,
    nodeCount: 1,
    source: { flowId: "flow-a", version: 2 },
    buildName: null,
    blueprintName: "Old report",
    blueprintVersion: 2,
  },
  {
    id: "run-old",
    status: "done",
    buildId: "0123456789",
    createdAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    totalCost: null,
    nodeCount: 1,
    buildName: null,
    blueprintName: null,
    blueprintVersion: null,
  },
];

const picture = '<svg xmlns="http://www.w3.org/2000/svg"><rect data-kind="background"/></svg>';

const fakeBridge = () =>
  ({
    listFlows: vi.fn(async () => flows),
    listBuilds: vi.fn(async () => builds),
    listRuns: vi.fn(async () => runs),
    renameFlow: vi.fn(async () => null),
    pinFlow: vi.fn(async () => null),
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
    buildPicture: vi.fn(async (key: { pendingId: string } | { buildId: string }) =>
      "buildId" in key ? { svg: picture } : { svg: null },
    ),
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

  it("pins a blueprint and reloads the lists", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().pin("flow-a", true);

    expect(bridge.pinFlow).toHaveBeenCalledWith({ flowId: "flow-a", pinned: true });
    expect(bridge.listFlows).toHaveBeenCalledTimes(1);
    expect(bridge.pinFlow.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.listFlows.mock.invocationCallOrder[0] ?? 0,
    );
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
  const withBlueprints = async (listed: typeof flows) => {
    const bridge = fakeBridge();
    bridge.listFlows.mockResolvedValue(listed);
    const library = createLibraryStore({ bridge });
    await library.getState().refresh();
    return library.getState();
  };

  const buildCards = [
    {
      id: "b-fix",
      name: "fix-login",
      blueprint: "Old report",
      version: 2,
      createdAt: 7,
      flowId: "flow-a",
      old: false,
      run: { id: "run-2", status: "interrupted" },
    },
    {
      id: "b-idle",
      name: "Old report",
      blueprint: "Old report",
      version: 2,
      createdAt: 6,
      flowId: "flow-a",
      old: false,
      run: { id: "run-idle", status: "done" },
    },
    {
      id: "b-gap",
      name: "b-gap",
      blueprint: "",
      version: null,
      createdAt: 5,
      flowId: "flow-a",
      old: false,
      run: null,
    },
    {
      id: "0123456789",
      name: "0123456789",
      blueprint: "",
      version: null,
      createdAt: 4,
      flowId: null,
      old: true,
      run: { id: "run-old", status: "done" },
    },
  ];

  it("names each build card from the build and its snapshot with no blueprints listed", async () => {
    expect(selectBuildCards(await withBlueprints([]))).toEqual(buildCards);
  });

  it("shows the blueprint name the build was made from, not the blueprint's name now", async () => {
    expect(selectBuildCards(await withBlueprints(flows))).toEqual(buildCards);
  });

  it("names each run card from its build and snapshot with no blueprints listed", async () => {
    expect(
      selectRunCards(await withBlueprints([])).map(({ id, name, version }) => ({
        id,
        name,
        version,
      })),
    ).toEqual([
      { id: "run-2", name: "fix-login", version: 2 },
      { id: "run-1", name: "fix-login", version: 2 },
      { id: "run-idle", name: "Old report", version: 2 },
      { id: "run-old", name: "0123456789", version: null },
    ]);
  });

  it("never says a card is not from a blueprint", async () => {
    const state = await withBlueprints([]);
    const shown = JSON.stringify([selectBuildCards(state), selectRunCards(state)]);

    expect(shown).not.toContain("Not from a blueprint");
  });
});

describe("pictures", () => {
  it("has no picture for a build until it is asked for, then keeps the one the engine gives", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    expect(selectPicture(library.getState(), { buildId: "b-fix" })).toBeUndefined();

    await library.getState().loadPicture({ buildId: "b-fix" });

    expect(bridge.buildPicture).toHaveBeenCalledTimes(1);
    expect(bridge.buildPicture).toHaveBeenCalledWith({ buildId: "b-fix" });
    expect(selectPicture(library.getState(), { buildId: "b-fix" })).toBe(picture);
  });

  it("keeps a pending build's answer apart from a build with the same id, and keeps a null answer", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });
    await library.getState().loadPicture({ buildId: "b-fix" });

    expect(selectPicture(library.getState(), { pendingId: "b-fix" })).toBeUndefined();

    await library.getState().loadPicture({ pendingId: "b-fix" });

    expect(bridge.buildPicture).toHaveBeenLastCalledWith({ pendingId: "b-fix" });
    expect(selectPicture(library.getState(), { pendingId: "b-fix" })).toBeNull();
    expect(selectPicture(library.getState(), { buildId: "b-fix" })).toBe(picture);
  });
});

describe("pinnedFirst", () => {
  const card = (flowId: string, pinned: boolean) => ({
    flowId,
    name: flowId,
    createdAt: "2026-01-01T00:00:00.000Z",
    versions: 1,
    lastSavedAt: "2026-01-02T00:00:00.000Z",
    buildConfig: null,
    pinned,
  });

  it("puts pinned blueprints first and keeps the given order within each group", () => {
    expect(
      pinnedFirst([
        card("a", false),
        card("b", true),
        card("c", false),
        card("d", true),
        card("e", false),
      ]).map((flow) => flow.flowId),
    ).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("leaves a list with nothing pinned as it was", () => {
    expect(pinnedFirst([card("a", false), card("b", false)]).map((flow) => flow.flowId)).toEqual([
      "a",
      "b",
    ]);
  });
});
