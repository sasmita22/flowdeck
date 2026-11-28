import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import {
  blueprintKindLabel,
  createLibraryStore,
  filterRunsByBuild,
  pinnedFirst,
  selectBuildCards,
  selectPicture,
  selectRunBuildOptions,
  selectRunCards,
  type LibraryBridge,
} from "../../../src/app/renderer/library-store.js";
import type { RunSummary } from "../../../src/core/run/store.js";
import { thenWire } from "../../fixtures/flow-builders.js";

const report = {
  flowId: "flow-a",
  name: "Report",
  createdAt: "2026-01-01T00:00:00.000Z",
  versions: 2,
  lastSavedAt: "2026-01-02T00:00:00.000Z",
  kind: "workflow" as const,
  buildConfig: { repo: "/code/shop" },
  variables: [],
  sends: [],
  sessions: [],
  uses: [],
  pinned: false,
};

const flows = [report];

const builds = [
  {
    id: "b-fix",
    name: "fix-login",
    dir: "/fd/workspaces/b-fix",
    createdAt: 7,
    source: { flowId: "flow-a", version: 2 },
    blueprintName: "Old report",
    blueprintVersion: 2,
  },
  {
    id: "b-idle",
    name: null,
    dir: "/fd/workspaces/b-idle",
    createdAt: 6,
    source: { flowId: "flow-a", version: 2 },
    blueprintName: "Old report",
    blueprintVersion: 2,
  },
  {
    id: "b-gap",
    name: null,
    dir: "/fd/workspaces/b-gap",
    createdAt: 5,
    source: { flowId: "flow-a", version: 1 },
    blueprintName: null,
    blueprintVersion: null,
  },
  {
    id: "0123456789",
    name: null,
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
    buildGone: false,
    number: 2,
    doneCount: 1,
  },
  {
    id: "run-1",
    status: "done",
    createdAt: "2026-01-03T00:00:00.000Z",
    endedAt: "2026-01-03T00:01:05.000Z",
    totalCost: 0.25,
    nodeCount: 2,
    ...fromFixLogin,
    buildGone: false,
    number: 1,
    doneCount: 2,
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
    buildGone: false,
    number: 1,
    doneCount: 1,
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
    buildGone: false,
    number: 1,
    doneCount: 1,
  },
];

const stages = {
  session: { name: "main" },
  nodes: [
    { id: "s1", type: "agent", label: "Write" },
    { id: "s2", type: "agent", label: "Review" },
  ],
  wires: [thenWire("s1", "s2")],
};

const picture = '<svgxmlns="http://www.w3.org/2000/svg"><rect data-kind="background"/></svg>';

const project = {
  repoFolder: "shop",
  path: "/fd/workspaces/b-fix/shop",
  branch: "flowdeck/fix-login-b-fix",
  branchCreated: true,
  base: "main",
  exists: true,
  dirty: false,
  unpushed: false,
};

const shopEntries = [
  { name: "src", kind: "folder" },
  { name: "README.md", kind: "file" },
];

const fakeBridge = () =>
  ({
    listFlows: vi.fn(async () => flows),
    listBuilds: vi.fn(async () => builds),
    listRuns: vi.fn(async () => runs),
    renameFlow: vi.fn(async () => null),
    pinFlow: vi.fn(async () => null),
    deleteFlow: vi.fn(async () => null),
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
        containers: [],
        settings: { buildModel: "sonnet", permissionMode: "default" },
      },
    })),
    doctor: vi.fn(async () => ({ installed: [] })),
    doctorWorktrees: vi.fn(async () => []),
    buildPicture: vi.fn(async (key: { pendingId: string } | { buildId: string }) =>
      "buildId" in key ? { svg: picture } : { svg: null },
    ),
    buildTree: vi.fn(async () => ({ paths: ["commands/p1.md", "manifest.json"] })),
    buildProject: vi.fn(async () => project),
    buildEntries: vi.fn(async ({ path }: { buildId: string; path: string }) =>
      path === "shop" ? shopEntries : [{ name: "x.ts", kind: "file" }],
    ),
    pendingBuildTree: vi.fn(async () => ({ paths: ["CLAUDE.md", "plugin/agents/a.md"] })),
    loadRun: vi.fn(async () => ({
      run: runs[1],
      name: "Report",
      stages,
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

  it("drops an old mark a build payload still carries", async () => {
    const bridge = fakeBridge();
    bridge.listBuilds.mockResolvedValueOnce(builds.map((build) => ({ ...build, old: true })));
    const library = createLibraryStore({ bridge });

    await library.getState().refresh();

    expect(library.getState().builds).toHaveLength(builds.length);
    for (const build of library.getState().builds) expect(build).not.toHaveProperty("old");
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

  it("asks before deleting a blueprint, and forgets the question on cancel without calling the engine", () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    library.getState().askDelete(report);
    expect(library.getState().confirmingDelete).toEqual({ flowId: "flow-a", name: "Report" });

    library.getState().cancelDelete();
    expect(library.getState().confirmingDelete).toBeNull();
    expect(bridge.deleteFlow).not.toHaveBeenCalled();
    expect(bridge.listFlows).not.toHaveBeenCalled();
  });

  it("deletes a blueprint, reloads the lists without it and closes the question", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });
    await library.getState().refresh();
    library.getState().askDelete(report);
    bridge.listFlows.mockResolvedValueOnce([]);

    await expect(library.getState().delete("flow-a")).resolves.toBe(true);

    expect(bridge.deleteFlow).toHaveBeenCalledWith({ flowId: "flow-a" });
    expect(bridge.deleteFlow.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.listFlows.mock.invocationCallOrder[1] ?? 0,
    );
    expect(library.getState().flows).toEqual([]);
    expect(library.getState().confirmingDelete).toBeNull();
  });

  it("holds the error, closes the question and answers false when the delete is refused", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });
    await library.getState().refresh();
    library.getState().askDelete(report);
    bridge.deleteFlow.mockRejectedValueOnce(new Error("Blueprint flow-a was deleted"));

    await expect(library.getState().delete("flow-a")).resolves.toBe(false);

    expect(library.getState().error).toBe("Blueprint flow-a was deleted");
    expect(library.getState().confirmingDelete).toBeNull();
    expect(bridge.listFlows).toHaveBeenCalledTimes(1);
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

  it("lists the connectors installed on this Mac, asking for no blueprint's needs", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().diagnose();

    expect(bridge.doctor).toHaveBeenCalledWith();
    expect(bridge.openFlow).not.toHaveBeenCalled();
    expect(library.getState().doctor).toEqual({ installed: [] });
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
      stages,
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
      stages: { session: { name: "" }, nodes: [], wires: [] },
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
      run: { id: "run-2", status: "interrupted" },
    },
    {
      id: "b-idle",
      name: "Old report",
      blueprint: "Old report",
      version: 2,
      createdAt: 6,
      flowId: "flow-a",
      run: { id: "run-idle", status: "done" },
    },
    {
      id: "b-gap",
      name: "b-gap",
      blueprint: "",
      version: null,
      createdAt: 5,
      flowId: "flow-a",
      run: null,
    },
    {
      id: "0123456789",
      name: "0123456789",
      blueprint: "",
      version: null,
      createdAt: 4,
      flowId: null,
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

  it("numbers each run card within its build and names it from the build, apart from the number", async () => {
    const cards = selectRunCards(await withBlueprints([]));

    expect(
      cards.map(({ id, number, name, buildGone, doneCount, nodeCount }) => ({
        id,
        number,
        name,
        buildGone,
        doneCount,
        nodeCount,
      })),
    ).toEqual([
      {
        id: "run-2",
        number: 2,
        name: "fix-login",
        buildGone: false,
        doneCount: 1,
        nodeCount: 2,
      },
      {
        id: "run-1",
        number: 1,
        name: "fix-login",
        buildGone: false,
        doneCount: 2,
        nodeCount: 2,
      },
      {
        id: "run-idle",
        number: 1,
        name: "Old report",
        buildGone: false,
        doneCount: 1,
        nodeCount: 1,
      },
      {
        id: "run-old",
        number: 1,
        name: "0123456789",
        buildGone: false,
        doneCount: 1,
        nodeCount: 1,
      },
    ]);
    expect(cards.filter((card) => card.name.includes("#"))).toEqual([]);
  });

  it("never says a card is not from a blueprint", async () => {
    const state = await withBlueprints([]);
    const shown = JSON.stringify([selectBuildCards(state), selectRunCards(state)]);

    expect(shown).not.toContain("Not from a blueprint");
  });

  it("carries a run's story line onto its card, and gives a run without one none", async () => {
    const bridge = fakeBridge();
    bridge.listRuns.mockResolvedValue([
      { ...runs[1], storyLine: "Fix-login ended done after both stages." },
      runs[2],
    ] as never);
    const library = createLibraryStore({ bridge });
    await library.getState().refresh();

    const [told, untold] = selectRunCards(library.getState());

    expect(told?.storyLine).toBe("Fix-login ended done after both stages.");
    expect(untold).not.toHaveProperty("storyLine");
  });
});

describe("build filter", () => {
  const goneFixLogin = {
    id: "run-gone",
    status: "done",
    createdAt: "2026-01-05T00:00:00.000Z",
    endedAt: "2026-01-05T00:01:00.000Z",
    totalCost: 0.1,
    nodeCount: 2,
    ...fromFixLogin,
    buildId: "b-fix-gone",
    buildGone: true,
    number: 1,
    doneCount: 0,
  };

  const withGoneBuild = async () => {
    const bridge = fakeBridge();
    bridge.listRuns.mockResolvedValue([...runs, goneFixLogin]);
    const library = createLibraryStore({ bridge });
    await library.getState().refresh();
    return library.getState();
  };

  it("offers each build once, named from the build or its id, and a gone build by its own name alone", async () => {
    const { runs: listed } = await withGoneBuild();

    expect(selectRunBuildOptions(listed)).toEqual([
      { buildId: "b-fix", label: "fix-login" },
      { buildId: "b-idle", label: "b-idle" },
      { buildId: "0123456789", label: "0123456789" },
      { buildId: "b-fix-gone", label: "fix-login" },
    ]);
  });

  it("shows no card for a deleted build, and keeps its runs' cards", async () => {
    const state = await withGoneBuild();

    expect(selectBuildCards(state).map((card) => card.id)).not.toContain("b-fix-gone");
    expect(
      selectRunCards(state)
        .filter((card) => card.buildId === "b-fix-gone")
        .map(({ id, name }) => ({ id, name })),
    ).toEqual([{ id: "run-gone", name: "fix-login" }]);
  });

  it("keeps every run card with no build chosen, and only the chosen build's cards otherwise", async () => {
    const cards = selectRunCards(await withGoneBuild());

    expect(filterRunsByBuild(cards, undefined).map((card) => card.id)).toEqual([
      "run-2",
      "run-1",
      "run-idle",
      "run-old",
      "run-gone",
    ]);
    expect(filterRunsByBuild(cards, "b-fix").map((card) => card.id)).toEqual(["run-2", "run-1"]);
    expect(filterRunsByBuild(cards, "b-fix-gone").map((card) => card.id)).toEqual(["run-gone"]);
  });

  it("offers no build for a run that names none, and leaves it out once a build is chosen", () => {
    const unbuilt: RunSummary = {
      id: "run-old",
      status: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      totalCost: null,
      nodeCount: 1,
      buildName: null,
      blueprintName: null,
      blueprintVersion: null,
      buildGone: false,
      number: 1,
      doneCount: 1,
    };

    expect(selectRunBuildOptions([unbuilt])).toEqual([]);
    expect(filterRunsByBuild(selectRunCards({ runs: [unbuilt] }), "0123456789")).toEqual([]);
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
    kind: "workflow" as const,
    buildConfig: null,
    variables: [],
    sessions: [],
    uses: [],
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

describe("build tree and project", () => {
  it("loads a live build's tree, files and project together", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().openFiles("b-fix");

    expect(bridge.buildTree).toHaveBeenCalledWith({ buildId: "b-fix" });
    expect(bridge.buildFiles).toHaveBeenCalledWith({ buildId: "b-fix" });
    expect(bridge.buildProject).toHaveBeenCalledWith({ buildId: "b-fix" });
    expect(library.getState().tree).toEqual({
      buildId: "b-fix",
      paths: ["commands/p1.md", "manifest.json"],
    });
    expect(library.getState().project).toEqual({ buildId: "b-fix", ...project });
    expect(library.getState().files?.selected).toBe("manifest.json");
  });

  it("reads each project folder once, one level at a time, for the open build", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });
    await library.getState().openFiles("b-fix");

    await library.getState().expandProjectFolder("shop");
    await library.getState().expandProjectFolder("shop");
    await library.getState().expandProjectFolder("shop/src");

    expect(bridge.buildEntries.mock.calls).toEqual([
      [{ buildId: "b-fix", path: "shop" }],
      [{ buildId: "b-fix", path: "shop/src" }],
    ]);
    expect(library.getState().projectEntries).toEqual({
      shop: shopEntries,
      "shop/src": [{ name: "x.ts", kind: "file" }],
    });
  });

  it("keeps the open build's project when an earlier build's answers arrive late", async () => {
    const bridge = fakeBridge();
    let answerProject: (value: typeof project) => void = () => undefined;
    bridge.buildProject.mockImplementationOnce(
      () => new Promise<typeof project>((resolve) => (answerProject = resolve)),
    );
    const library = createLibraryStore({ bridge });
    const first = library.getState().openFiles("b-fix");
    await vi.waitFor(() => expect(bridge.buildProject).toHaveBeenCalledTimes(1));

    await library.getState().openFiles("b-other");
    answerProject({ ...project, repoFolder: "late" });
    await first;

    expect(library.getState().project).toEqual({ buildId: "b-other", ...project });
    expect(library.getState().files?.buildId).toBe("b-other");
  });

  it("drops a project folder answer that arrives after another build opened", async () => {
    const bridge = fakeBridge();
    let answerEntries: (value: typeof shopEntries) => void = () => undefined;
    bridge.buildEntries.mockImplementationOnce(
      () => new Promise<typeof shopEntries>((resolve) => (answerEntries = resolve)),
    );
    const library = createLibraryStore({ bridge });
    await library.getState().openFiles("b-fix");
    const expanding = library.getState().expandProjectFolder("shop");

    await library.getState().openFiles("b-other");
    answerEntries(shopEntries);
    await expanding;

    expect(library.getState().projectEntries).toEqual({});
  });

  it("keeps a pending build's workspace paths, or null before its checkout is laid down", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().loadPendingTree("pending-1");

    expect(bridge.pendingBuildTree).toHaveBeenCalledWith({ pendingId: "pending-1" });
    expect(library.getState().pendingTrees).toEqual({
      "pending-1": ["CLAUDE.md", "plugin/agents/a.md"],
    });

    bridge.pendingBuildTree.mockResolvedValueOnce(null as never);
    await library.getState().loadPendingTree("pending-2");

    expect(library.getState().pendingTrees).toEqual({
      "pending-1": ["CLAUDE.md", "plugin/agents/a.md"],
      "pending-2": null,
    });
  });

  it("shows no project for a build without one", async () => {
    const bridge = fakeBridge();
    bridge.buildProject.mockResolvedValueOnce(null as never);
    const library = createLibraryStore({ bridge });

    await library.getState().openFiles("b-fix");

    expect(library.getState()).toMatchObject({ project: null, error: null });
    expect(library.getState().files?.selected).toBe("manifest.json");
  });

  it("forgets the last build's project folders when another build opens", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });
    await library.getState().openFiles("b-fix");
    await library.getState().expandProjectFolder("shop");

    await library.getState().openFiles("b-other");
    await library.getState().expandProjectFolder("shop");

    expect(bridge.buildEntries.mock.calls).toEqual([
      [{ buildId: "b-fix", path: "shop" }],
      [{ buildId: "b-other", path: "shop" }],
    ]);
  });

  it("reads no project folder while no build is open", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });

    await library.getState().expandProjectFolder("shop");

    expect(bridge.buildEntries).not.toHaveBeenCalled();
  });

  it("holds the error and reads the folder again when a project folder cannot be read", async () => {
    const bridge = fakeBridge();
    const library = createLibraryStore({ bridge });
    await library.getState().openFiles("b-fix");
    bridge.buildEntries.mockRejectedValueOnce(new Error("shop is outside the build's project"));

    await library.getState().expandProjectFolder("shop");

    expect(library.getState()).toMatchObject({
      projectEntries: {},
      error: "shop is outside the build's project",
    });

    await library.getState().expandProjectFolder("shop");

    expect(library.getState()).toMatchObject({
      projectEntries: { shop: shopEntries },
      error: null,
    });
  });

  it("holds the error when a build's tree cannot be read", async () => {
    const bridge = fakeBridge();
    bridge.buildTree.mockRejectedValueOnce(new Error("No build b-fix"));
    const library = createLibraryStore({ bridge });

    await library.getState().openFiles("b-fix");

    expect(library.getState()).toMatchObject({ tree: null, error: "No build b-fix" });
    expect(bridge.buildFiles).not.toHaveBeenCalled();
  });

  it("holds the error when a pending build's workspace cannot be read", async () => {
    const bridge = fakeBridge();
    bridge.pendingBuildTree.mockRejectedValueOnce(new Error("engine exited"));
    const library = createLibraryStore({ bridge });

    await library.getState().loadPendingTree("pending-1");

    expect(library.getState()).toMatchObject({ pendingTrees: {}, error: "engine exited" });
  });
});

describe("blueprintKindLabel", () => {
  it("names each of the four kinds in plain words", () => {
    expect(blueprintKindLabel).toEqual({
      workflow: "Workflow",
      "node-library": "Node library",
      "session-library": "Session library",
      incomplete: "Incomplete",
    });
  });
});
