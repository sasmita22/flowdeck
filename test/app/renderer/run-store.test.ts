import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import {
  createRunStore,
  losesWork,
  needsSessionSetup,
  selectBuildRefusal,
  selectCanBuild,
  selectDeleteWorktrees,
  selectExistingBranches,
  selectKeptNote,
  selectKeptNotes,
  selectLiveBadge,
  selectNodeDisplay,
  selectRunDisabled,
  selectRunHint,
  selectRunningCount,
  selectRunSnapshot,
  selectRunSummary,
  selectSessionFailure,
  selectStartedSessions,
  variableGroups,
  type RunView,
} from "../../../src/app/renderer/run-store.js";
import { createSaveStore, type SaveBridge } from "../../../src/app/renderer/save-store.js";
import type { BuildConfig, Flow, NodeType } from "../../../src/core/flow/schema.js";
import type { FoundVariable } from "../../../src/core/flow/variables.js";
import { recommendedBranch } from "../../../src/core/run/branch-name.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import { runSnapshot } from "../../../src/core/run/snapshot.js";
import type { NodeState } from "../../../src/core/run/state.js";
import {
  agent,
  branch,
  flow,
  flowSettings,
  onMainFlow,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";
import { flowSummary } from "../../fixtures/flow-summary.js";

type RunBridge = Pick<
  FlowdeckBridge,
  | "buildVersion"
  | "runBuild"
  | "getRunState"
  | "onRunState"
  | "runOptions"
  | "stopRun"
  | "retryNode"
  | "resumeRun"
  | "runCost"
  | "runPipeline"
  | "onRunSessions"
  | "deleteBuild"
  | "deleteRun"
  | "deletePendingBuild"
  | "deletePreview"
  | "deletePendingPreview"
  | "writeStory"
  | "defaultBranch"
  | "listBranches"
  | "checkedOutBranches"
  | "openFlow"
  | "expandFlow"
>;

type Status = "running" | "done" | "failed" | "stopped" | "interrupted";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const snapshot = (
  status: Status,
  nodes: Record<string, NodeState> = { "agent-1": "waiting" },
  runId = "run-1",
) => ({ runId, status, nodes });

const configured = (buildConfig: BuildConfig, buildModel = "sonnet"): Flow => {
  const base = onMainFlow(
    [branch("decide", "ship"), agent("plan", { settings: { instructions: "Say {{ticket}}." } })],
    [thenWire("decide", "plan")],
  );
  return {
    ...base,
    containers: base.containers.map((container) =>
      container.kind === "session"
        ? { ...container, repo: buildConfig.repo ?? "", branch: buildConfig.base ?? "" }
        : container,
    ),
    settings: { ...base.settings, buildModel },
  };
};

const shopRepo: BuildConfig = { repo: "/code/shop" };

const found: FoundVariable[] = [
  { name: "ship", kind: "yes-no", nodeIds: ["decide"] },
  { name: "ticket", kind: "text", nodeIds: ["plan"] },
];

const fromCard = { flowId: "flow-b", version: 4, buildConfig: shopRepo, variables: found };

const stage = (nodeId: string) => ({
  nodeId,
  type: "agent",
  label: "Write",
  status: "done",
  retries: 0,
  tokens: 10,
  cost: 0.5,
  decisions: [],
  timeline: [],
  activity: [],
});

const group = (name: string, status: string, items: unknown[]) => ({ name, status, items });

const inWorkspace = (...items: unknown[]) => [group("workspace", "running", items)];

const built = { kind: "built", id: "b-0f3a9c2e", hash: "h1", dir: "/fd/workspaces/b-0f3a9c2e" };

const setup = async (
  options: {
    latest?: Flow | null;
    automatic?: boolean;
    defaultBranch?: string;
    runState?: Promise<unknown>;
    built?: Flow;
    branches?: string[];
    checkedOut?: Record<string, string>;
    expanded?: (flow: unknown) => unknown;
  } = {},
) => {
  const calls: string[] = [];
  let pushListener: (value: unknown) => void = () => undefined;
  let sessionsListener: (value: unknown) => void = () => undefined;

  const saveBridge = {
    saveFlow: vi.fn<(flow: unknown) => Promise<unknown>>(async () => {
      calls.push("saveFlow");
      return { kind: "saved", flowId: "flow-1", version: 2 };
    }),
    openFlow: vi.fn<(payload: { flowId?: string }) => Promise<unknown>>(async () =>
      options.latest === undefined || options.latest === null
        ? null
        : { flowId: "flow-1", name: "Untitled", version: 1, flow: options.latest },
    ),
    renameFlow: vi.fn<(payload: { flowId: string; name: string }) => Promise<unknown>>(
      async () => null,
    ),
    setDirty: vi.fn<(dirty: boolean) => void>(),
    onCloseRequest: vi.fn(() => () => {}),
    answerClose: vi.fn<(answer: "close" | "cancel") => void>(),
  } satisfies SaveBridge;

  const bridge = {
    buildVersion: vi.fn<FlowdeckBridge["buildVersion"]>(async () => {
      calls.push("buildVersion");
      return built;
    }),
    runBuild: vi.fn<FlowdeckBridge["runBuild"]>(async () => {
      calls.push("runBuild");
      return { kind: "started", runId: "run-1" };
    }),
    getRunState: vi.fn<FlowdeckBridge["getRunState"]>(
      () => options.runState ?? Promise.resolve(null),
    ),
    onRunState: vi.fn((listener: (value: unknown) => void) => {
      calls.push("onRunState");
      pushListener = listener;
      return () => {};
    }),
    runOptions: vi.fn<FlowdeckBridge["runOptions"]>(async () => ({
      kind: "choices",
      automatic: options.automatic ?? false,
    })),
    stopRun: vi.fn<FlowdeckBridge["stopRun"]>(async () => ({ stopped: true })),
    retryNode: vi.fn<FlowdeckBridge["retryNode"]>(async ({ runId }) => ({
      kind: "started",
      runId,
    })),
    resumeRun: vi.fn<FlowdeckBridge["resumeRun"]>(async ({ runId }) => ({
      kind: "started",
      runId,
    })),
    runCost: vi.fn<FlowdeckBridge["runCost"]>(async () => ({
      nodes: [{ nodeId: "p1", tokens: 10, cost: 0.5, ms: 1000 }],
      total: { tokens: 10, cost: 0.5, ms: 1000 },
    })),
    runPipeline: vi.fn<FlowdeckBridge["runPipeline"]>(async () => inWorkspace(stage("a1"))),
    onRunSessions: vi.fn((listener: (value: unknown) => void) => {
      sessionsListener = listener;
      return () => {};
    }),
    deleteBuild: vi.fn<FlowdeckBridge["deleteBuild"]>(async () => ({ ok: true })),
    deleteRun: vi.fn<FlowdeckBridge["deleteRun"]>(async () => undefined),
    deletePendingBuild: vi.fn<FlowdeckBridge["deletePendingBuild"]>(async () => undefined),
    deletePreview: vi.fn<FlowdeckBridge["deletePreview"]>(async () => ({
      dirtyWorktree: false,
      unpushedBranch: false,
    })),
    deletePendingPreview: vi.fn<FlowdeckBridge["deletePendingPreview"]>(async () => ({
      dirtyWorktree: false,
      unpushedBranch: false,
    })),
    writeStory: vi.fn<FlowdeckBridge["writeStory"]>(async () => ({ ok: true })),
    defaultBranch: vi.fn<FlowdeckBridge["defaultBranch"]>(async () => {
      calls.push("defaultBranch");
      return options.defaultBranch ?? "main";
    }),
    listBranches: vi.fn<FlowdeckBridge["listBranches"]>(async () => options.branches ?? ["main"]),
    checkedOutBranches: vi.fn<FlowdeckBridge["checkedOutBranches"]>(
      async () => options.checkedOut ?? {},
    ),
    expandFlow: vi.fn<FlowdeckBridge["expandFlow"]>(async ({ flow: sent }) =>
      options.expanded === undefined ? { flow: sent, uses: [] } : options.expanded(sent),
    ),
    openFlow: vi.fn<FlowdeckBridge["openFlow"]>(async ({ flowId }) => ({
      flowId,
      name: "Untitled",
      version: 4,
      flow:
        options.built ??
        options.latest ??
        flow([agent("agent-1")], [], flowSettings, {
          containers: [sessionContainer(["agent-1"])],
        }),
    })),
  } satisfies RunBridge;

  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge: saveBridge, canvas });
  await save.getState().open();
  const timers = new Set<() => void>();
  const every = vi.fn((_ms: number, fn: () => void) => {
    timers.add(fn);
    return () => timers.delete(fn);
  });
  const tick = async () => {
    for (const fn of [...timers]) fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const run = createRunStore({ bridge, save, canvas, every });
  const push = (value: unknown) => pushListener(value);
  const pushSessions = (value: unknown) => sessionsListener(value);

  return { bridge, saveBridge, canvas, save, run, calls, push, pushSessions, tick };
};

const makeDirty = (canvas: ReturnType<typeof createCanvasStore>) =>
  canvas.getState().drop("gate", { x: 200, y: 0 });

const card = (
  run: { id: string; status: Status } | null = null,
  old = false,
): { old: boolean; run: { id: string; status: Status } | null } => ({ old, run });

describe("connect", () => {
  it("keeps each pushed snapshot under its own run", async () => {
    const { run, push } = await setup();
    await run.getState().connect();

    push(snapshot("running", { a: "sent" }, "run-1"));
    push(snapshot("running", { b: "running" }, "run-2"));
    push(snapshot("done", { a: "done" }, "run-1"));

    expect(selectRunSnapshot(run.getState(), "run-1")).toEqual(
      snapshot("done", { a: "done" }, "run-1"),
    );
    expect(selectRunSnapshot(run.getState(), "run-2")).toEqual(
      snapshot("running", { b: "running" }, "run-2"),
    );
    expect(selectRunSnapshot(run.getState(), "run-3")).toBeNull();
  });

  it("ignores payloads that are not run snapshots", async () => {
    const { run, push } = await setup();
    await run.getState().connect();

    push(snapshot("running"));
    push({ runId: "run-1", status: "sideways", nodes: {} });
    push({ nodes: "none" });
    push("done");

    expect(selectRunSnapshot(run.getState(), "run-1")).toEqual(snapshot("running"));
  });
});

describe("view", () => {
  it("fetches the run's state once, for a run that pushed before the window subscribed", async () => {
    const { bridge, run } = await setup({
      runState: Promise.resolve(snapshot("running", { g1: "needs-you" }, "run-7")),
    });
    await run.getState().connect();

    await run.getState().view("run-7");

    expect(bridge.getRunState).toHaveBeenCalledExactlyOnceWith("run-7");
    expect(selectRunSnapshot(run.getState(), "run-7")).toEqual(
      snapshot("running", { g1: "needs-you" }, "run-7"),
    );
  });

  it("keeps a snapshot pushed while the fetch was out over the fetched one", async () => {
    const fetched = deferred<unknown>();
    const { run, push } = await setup({ runState: fetched.promise });
    await run.getState().connect();

    const viewing = run.getState().view("run-7");
    push(snapshot("done", { g1: "done" }, "run-7"));
    fetched.resolve(snapshot("running", { g1: "needs-you" }, "run-7"));
    await viewing;

    expect(selectRunSnapshot(run.getState(), "run-7")).toEqual(
      snapshot("done", { g1: "done" }, "run-7"),
    );
  });

  it("stores nothing when the run has no state or the answer is not a snapshot", async () => {
    for (const answer of [null, { runId: "run-7", status: "sideways", nodes: {} }]) {
      const { run } = await setup({ runState: Promise.resolve(answer) });
      await run.getState().view("run-7");
      expect(selectRunSnapshot(run.getState(), "run-7")).toBeNull();
    }
  });
});

describe("selectRunningCount", () => {
  it("counts every run whose latest snapshot is running", async () => {
    const { run, push } = await setup();
    await run.getState().connect();
    expect(selectRunningCount(run.getState())).toBe(0);

    push(snapshot("running", {}, "run-1"));
    push(snapshot("running", {}, "run-2"));
    push(snapshot("done", {}, "run-3"));
    expect(selectRunningCount(run.getState())).toBe(2);

    push(snapshot("stopped", {}, "run-1"));
    expect(selectRunningCount(run.getState())).toBe(1);
  });
});

describe("the Build dialog", () => {
  it("opens from the canvas on the saved version, prefilled with the blueprint's repo, base and defaults", async () => {
    const { bridge, run, calls } = await setup({
      latest: configured({ ...shopRepo, base: "dev" }),
    });

    await run.getState().openBuild();

    expect(calls).toEqual([]);
    expect(bridge.defaultBranch).not.toHaveBeenCalled();
    expect(run.getState().buildDialog).toEqual({
      flowId: "flow-1",
      version: 1,
      name: "",
      repo: "/code/shop",
      base: "dev",
      variables: found,
      values: { ship: false },
      buildModel: "sonnet",
      branches: ["main"],
      checkedOut: {},
      branchMode: "new",
      branchName: "flowdeck/",
      branchNameEdited: false,
      existingBranch: null,
      error: null,
      problem: null,
      ignored: [],
      target: {
        repoOverride: true,
        existingBranch: true,
        branch: true,
        sessions: [{ name: "main", repo: "/code/shop", branch: "dev" }],
      },
      step: "form",
    });
  });

  it("saves a dirty canvas first and opens on the version that save made", async () => {
    const { canvas, run, calls } = await setup({ latest: configured(shopRepo) });
    makeDirty(canvas);

    await run.getState().openBuild();

    expect(calls).toEqual(["saveFlow", "defaultBranch"]);
    expect(run.getState().buildDialog).toMatchObject({ flowId: "flow-1", version: 2 });
  });

  it("opens nothing and holds the save error when the save fails", async () => {
    const { saveBridge, canvas, run } = await setup({ latest: configured(shopRepo) });
    makeDirty(canvas);
    saveBridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });

    await run.getState().openBuild();

    expect(run.getState().buildDialog).toBeNull();
    expect(run.getState().error).toBe("disk full");
  });

  it("opens nothing and shows no error when the save warning is cancelled", async () => {
    const { saveBridge, canvas, save, run } = await setup({ latest: configured(shopRepo) });
    canvas
      .getState()
      .setLibraries(
        [flowSummary("w1", "workflow", ["flow-1"]), flowSummary("flow-1", "node-library", [])],
        "flow-1",
      );
    makeDirty(canvas);

    const opening = run.getState().openBuild();
    await vi.waitFor(() => expect(save.getState().saveWarning).toEqual({ count: 1 }));
    save.getState().answerSaveWarning("cancel");
    await opening;

    expect(saveBridge.saveFlow).not.toHaveBeenCalled();
    expect(run.getState().buildDialog).toBeNull();
    expect(run.getState().error).toBeNull();
  });

  it("opens for a blueprint's latest version, starting from the repo's default branch when it names no base", async () => {
    const { bridge, canvas, run, calls } = await setup({
      defaultBranch: "trunk",
      built: configured(shopRepo),
    });
    makeDirty(canvas);

    await run.getState().openBuild(fromCard);

    expect(calls).toEqual(["defaultBranch"]);
    expect(bridge.defaultBranch).toHaveBeenCalledWith({ repo: "/code/shop" });
    expect(run.getState().buildDialog).toMatchObject({
      flowId: "flow-b",
      version: 4,
      repo: "/code/shop",
      base: "trunk",
      variables: found,
      values: { ship: false },
    });
  });

  it("leaves the base empty when the blueprint names no repo", async () => {
    const { bridge, run } = await setup({ built: configured({}) });

    await run
      .getState()
      .openBuild({ flowId: "flow-b", version: 4, buildConfig: {}, variables: [] });

    expect(bridge.defaultBranch).not.toHaveBeenCalled();
    expect(run.getState().buildDialog).toMatchObject({ repo: "", base: "" });
  });

  it("cannot build until the name, repo, base and every text value are set", async () => {
    const { run } = await setup();
    await run.getState().openBuild(fromCard);
    const canBuild = () => selectCanBuild(run.getState());

    expect(canBuild()).toBe(false);
    run.getState().editBuild({ name: "fix-login" });
    expect(canBuild()).toBe(false);
    run.getState().setValue("ticket", "FD-1");
    expect(canBuild()).toBe(true);
    run.getState().setValue("ticket", "");
    expect(canBuild()).toBe(false);
    run.getState().setValue("ticket", "FD-1");
    run.getState().editBuild({ base: "" });
    expect(canBuild()).toBe(false);
    run.getState().editBuild({ base: "main", repo: "" });
    expect(canBuild()).toBe(false);
  });

  it("is false with no dialog open", async () => {
    const { run } = await setup();

    expect(selectCanBuild(run.getState())).toBe(false);
  });

  it("builds with the name, repo, base and values, and closes", async () => {
    const { bridge, run } = await setup({ built: configured(shopRepo) });
    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");

    await expect(run.getState().confirmBuild()).resolves.toBe("b-0f3a9c2e");

    expect(bridge.buildVersion).toHaveBeenCalledWith({
      flowId: "flow-b",
      version: 4,
      name: "fix-login",
      repo: "/code/shop",
      base: "main",
      branch: { mode: "new", name: "flowdeck/fix-login", base: "main" },
      values: { ship: false, ticket: "FD-1" },
      buildModel: "sonnet",
    });
    expect(run.getState()).toMatchObject({ buildDialog: null, error: null });
  });

  it("builds with the build model given in the dialog", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login", buildModel: "haiku" });
    run.getState().setValue("ticket", "FD-1");

    await run.getState().confirmBuild();

    expect(bridge.buildVersion).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fix-login", buildModel: "haiku" }),
    );
  });

  it("starts the build model field from the blueprint's build model, opened from the canvas", async () => {
    const { run } = await setup({ latest: configured(shopRepo, "opus") });

    await run.getState().openBuild();

    expect(run.getState().buildDialog?.buildModel).toBe("opus");
  });

  it("starts the build model field from the blueprint's build model, opened from its card", async () => {
    const { run } = await setup({ built: configured(shopRepo, "haiku") });

    await run.getState().openBuild(fromCard);

    expect(run.getState().buildDialog?.buildModel).toBe("haiku");
  });

  it("asks for the same found variables from the canvas and from the blueprint's card", async () => {
    const { run } = await setup({ latest: configured(shopRepo) });
    const asked = () =>
      run.getState().buildDialog?.variables.map(({ name, kind }) => ({ name, kind }));

    await run.getState().openBuild();
    const fromCanvas = asked();
    run.getState().cancelBuild();
    await run.getState().openBuild(fromCard);

    expect(fromCanvas).toEqual([
      { name: "ship", kind: "yes-no" },
      { name: "ticket", kind: "text" },
    ]);
    expect(asked()).toEqual(fromCanvas);
    expect(run.getState().buildDialog?.values).toEqual({ ship: false });
  });

  it("refuses to build while a text value is empty, naming it, and builds nothing", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login" });

    expect(selectCanBuild(run.getState())).toBe(false);
    expect(selectBuildRefusal(run.getState())).toBe("Give a value for ticket");
    await expect(run.getState().confirmBuild()).resolves.toBeNull();
    expect(bridge.buildVersion).not.toHaveBeenCalled();

    run.getState().setValue("ticket", "FD-1");

    expect(selectBuildRefusal(run.getState())).toBeNull();
    expect(selectCanBuild(run.getState())).toBe(true);
  });

  it("can build a blueprint with no found variables", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild({ ...fromCard, variables: [] });
    run.getState().editBuild({ name: "fix-login" });

    expect(selectCanBuild(run.getState())).toBe(true);
    expect(selectBuildRefusal(run.getState())).toBeNull();
    await run.getState().confirmBuild();
    expect(bridge.buildVersion).toHaveBeenCalledWith(expect.objectContaining({ values: {} }));
  });

  it("does not build while it cannot", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);

    await expect(run.getState().confirmBuild()).resolves.toBeNull();

    expect(bridge.buildVersion).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a name that is not kebab-case",
      '"Fix Login" is not a build name: use lowercase letters, digits and single hyphens, like fix-login.',
    ],
    ["a name already taken", "A build named fix-login already exists."],
    ["a folder that is not a git repo", "/code/shop is not a git repository."],
  ])("stays open on %s and shows the refusal", async (_case, message) => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");
    bridge.buildVersion.mockResolvedValueOnce({ kind: "error", message });

    await expect(run.getState().confirmBuild()).resolves.toBeNull();

    expect(run.getState().buildDialog).toMatchObject({ name: "fix-login", error: message });
  });

  it("clears the refusal once the name is edited", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");
    bridge.buildVersion.mockResolvedValueOnce({ kind: "error", message: "taken" });
    await run.getState().confirmBuild();

    run.getState().editBuild({ name: "fix-login-2" });

    expect(run.getState().buildDialog?.error).toBeNull();
  });

  it("closes with no error on a started build and answers its pending id", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");
    bridge.buildVersion.mockResolvedValueOnce({ kind: "started", pendingId: "pb-7" });

    await expect(run.getState().confirmBuild()).resolves.toBe("pb-7");

    expect(run.getState()).toMatchObject({
      buildDialog: null,
      error: null,
      problems: null,
      starting: false,
    });
  });

  it("stays open and shows the problems of a refused build", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");
    const problems = [{ node: "agent-1", field: "text", text: "Write the prompt." }];
    bridge.buildVersion.mockResolvedValueOnce({ kind: "error", message: "Not built", problems });

    await expect(run.getState().confirmBuild()).resolves.toBeNull();

    expect(run.getState()).toMatchObject({
      buildDialog: { name: "fix-login", error: "Not built" },
      problems,
      starting: false,
    });
  });

  it("cancel closes it without building", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild(fromCard);

    run.getState().cancelBuild();

    expect(run.getState().buildDialog).toBeNull();
    expect(bridge.buildVersion).not.toHaveBeenCalled();
  });
});

const labelled = (source: Flow, labels: Record<string, string>): Flow => ({
  ...source,
  nodes: source.nodes.map((node) => ({ ...node, label: labels[node.id] ?? node.label })),
});

const withLooseNodes = (): Flow =>
  labelled(
    flow(
      [trigger("start"), agent("a"), output("stop"), agent("b"), agent("c"), agent("d")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("c", "d")],
    ),
    { b: "B", c: "C", d: "" },
  );

const looseNodes = [
  { id: "b", label: "B" },
  { id: "c", label: "C" },
  { id: "d", label: "Agent" },
];

describe("the Build dialog's confirm step", () => {
  const ready = async (built: Flow) => {
    const opened = await setup({ built });
    await opened.run.getState().openBuild(fromCard);
    opened.run.getState().editBuild({ name: "fix-login" });
    opened.run.getState().setValue("ticket", "FD-1");
    return opened;
  };

  it("lists the nodes off the main flow of the saved version the canvas builds", async () => {
    const { bridge, run } = await setup({ latest: withLooseNodes() });

    await run.getState().openBuild();

    expect(bridge.openFlow).toHaveBeenCalledWith({ flowId: "flow-1" });
    expect(run.getState().buildDialog).toMatchObject({ ignored: looseNodes, step: "form" });
  });

  it("reads the blueprint's saved version when opened from the Blueprints page", async () => {
    const { bridge, run } = await setup({ built: withLooseNodes() });

    await run.getState().openBuild(fromCard);

    expect(bridge.openFlow).toHaveBeenCalledWith({ flowId: "flow-b" });
    expect(run.getState().buildDialog).toMatchObject({
      flowId: "flow-b",
      version: 4,
      ignored: looseNodes,
      step: "form",
    });
  });

  it("asks to confirm before building when nodes are ignored", async () => {
    const { bridge, run } = await ready(withLooseNodes());

    await expect(run.getState().confirmBuild()).resolves.toBeNull();

    expect(bridge.buildVersion).not.toHaveBeenCalled();
    expect(run.getState().buildDialog).toMatchObject({ name: "fix-login", step: "confirm" });
  });

  it("builds once on Build anyway", async () => {
    const { bridge, run } = await ready(withLooseNodes());
    await run.getState().confirmBuild();

    await expect(run.getState().confirmBuild()).resolves.toBe("b-0f3a9c2e");

    expect(bridge.buildVersion).toHaveBeenCalledTimes(1);
    expect(run.getState().buildDialog).toBeNull();
  });

  it("builds nothing on Cancel", async () => {
    const { bridge, run } = await ready(withLooseNodes());
    await run.getState().confirmBuild();
    expect(run.getState().buildDialog).toMatchObject({ step: "confirm" });

    run.getState().cancelBuild();

    expect(run.getState().buildDialog).toBeNull();
    expect(bridge.buildVersion).not.toHaveBeenCalled();
  });

  it("builds straight away when every node is on the main flow", async () => {
    const { bridge, run } = await ready(onMainFlow([agent("a")], []));
    expect(run.getState().buildDialog).toMatchObject({ ignored: [], step: "form" });

    await expect(run.getState().confirmBuild()).resolves.toBe("b-0f3a9c2e");

    expect(bridge.buildVersion).toHaveBeenCalledTimes(1);
  });
});

describe("the Build dialog on a workflow with two session containers", () => {
  const twoSessions = (): Flow =>
    flow(
      [
        trigger("w-start"),
        output("w-stop"),
        trigger("s"),
        agent("a"),
        output("t"),
        trigger("u"),
        agent("b"),
        output("v"),
        { ...agent("loose"), label: "Loose" },
      ],
      [
        thenWire("w-start", "w-stop"),
        thenWire("s", "a"),
        thenWire("a", "t"),
        thenWire("u", "b"),
        thenWire("b", "v"),
      ],
      flowSettings,
      {
        containers: [
          workspaceContainer(["w-start", "w-stop"]),
          sessionContainer(["s", "a", "t"], { repo: "/code/shop", branch: "dev" }),
          sessionContainer(["u", "b", "v", "loose"], {
            id: "session-2",
            name: "web",
            repo: "/code/blog",
            branch: "main",
          }),
        ],
      },
    );

  it("takes the repo and base from the first session container", async () => {
    const { run } = await setup({ latest: twoSessions() });

    await run.getState().openBuild();

    expect(run.getState().buildDialog).toMatchObject({ repo: "/code/shop", base: "dev" });
  });

  it("lists as ignored only what no container's own Start reaches", async () => {
    const { run } = await setup({ built: twoSessions() });

    await run.getState().openBuild(fromCard);

    expect(run.getState().buildDialog?.ignored).toEqual([{ id: "loose", label: "Loose" }]);
  });

  it("carries the build target of the saved version", async () => {
    const { run } = await setup({ built: twoSessions() });

    await run.getState().openBuild(fromCard);

    expect(run.getState().buildDialog?.target).toEqual({
      repoOverride: false,
      existingBranch: false,
      branch: true,
      sessions: [
        { name: "main", repo: "/code/shop", branch: "dev" },
        { name: "web", repo: "/code/blog", branch: "main" },
      ],
    });
  });

  it("builds without a repo or base and sends only a new branch name", async () => {
    const { bridge, run } = await setup({ built: onMainFlowTwoSessions() });
    await run.getState().openBuild({ ...fromCard, buildConfig: {}, variables: [] });
    run.getState().editBuild({ name: "fix-login", branchMode: "existing" });

    expect(selectCanBuild(run.getState())).toBe(true);
    await expect(run.getState().confirmBuild()).resolves.toBe("b-0f3a9c2e");

    const sent = bridge.buildVersion.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty("repo");
    expect(sent).not.toHaveProperty("base");
    expect(sent?.branch).toEqual({ mode: "new", name: "flowdeck/fix-login", base: "" });
  });

  const onMainFlowTwoSessions = (): Flow => {
    const withLoose = twoSessions();
    return {
      ...withLoose,
      nodes: withLoose.nodes.filter((node) => node.id !== "loose"),
      containers: withLoose.containers.map((container) => ({
        ...container,
        nodes: container.nodes.filter((id) => id !== "loose"),
      })),
    };
  };
});

describe("the Build dialog on a workspace with no session container", () => {
  const workspaceOnly = (): Flow =>
    flow([trigger("w-start"), output("w-stop")], [thenWire("w-start", "w-stop")], flowSettings, {
      containers: [workspaceContainer(["w-start", "w-stop"])],
    });

  it("builds with no repo and no branch, and sends neither", async () => {
    const { bridge, run } = await setup({ built: workspaceOnly() });
    await run.getState().openBuild({ ...fromCard, buildConfig: {}, variables: [] });
    run.getState().editBuild({ name: "notes" });

    expect(selectCanBuild(run.getState())).toBe(true);
    await expect(run.getState().confirmBuild()).resolves.toBe("b-0f3a9c2e");

    const sent = bridge.buildVersion.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty("repo");
    expect(sent).not.toHaveProperty("base");
    expect(sent).not.toHaveProperty("branch");
  });
});

describe("the Build dialog's repository", () => {
  const settle = () => new Promise((done) => setTimeout(done, 0));

  const opened = async () => {
    const ready = await setup({ built: configured({ repo: "/a", base: "dev" }) });
    await ready.run.getState().openBuild({
      flowId: "flow-b",
      version: 4,
      buildConfig: { repo: "/a", base: "dev" },
      variables: [],
    });
    ready.bridge.defaultBranch.mockClear();
    return { ...ready, flowBefore: ready.canvas.getState().flow };
  };

  const dialogOf = (run: Awaited<ReturnType<typeof opened>>["run"]) => run.getState().buildDialog;

  it("clears the base at once on a new repository, then starts from that repository's default branch", async () => {
    const { run, bridge, canvas, flowBefore } = await opened();
    const reply = deferred<unknown>();
    bridge.defaultBranch.mockReturnValueOnce(reply.promise);

    run.getState().editBuild({ repo: "/b" });

    expect(dialogOf(run)).toMatchObject({ repo: "/b", base: "" });
    expect(bridge.defaultBranch).toHaveBeenCalledExactlyOnceWith({ repo: "/b" });
    reply.resolve("main");
    await settle();
    expect(dialogOf(run)).toMatchObject({ repo: "/b", base: "main" });
    expect(canvas.getState().flow).toBe(flowBefore);
  });

  it("keeps the base and asks nothing when the same repository is set again", async () => {
    const { run, bridge, canvas, flowBefore } = await opened();

    run.getState().editBuild({ repo: "/a" });
    await settle();

    expect(dialogOf(run)).toMatchObject({ repo: "/a", base: "dev" });
    expect(bridge.defaultBranch).not.toHaveBeenCalled();
    expect(canvas.getState().flow).toBe(flowBefore);
  });

  it("ignores the default branch of a repository that was replaced before it answered", async () => {
    const { run, bridge, canvas, flowBefore } = await opened();
    const forB = deferred<unknown>();
    const forC = deferred<unknown>();
    bridge.defaultBranch.mockReturnValueOnce(forB.promise).mockReturnValueOnce(forC.promise);

    run.getState().editBuild({ repo: "/b" });
    run.getState().editBuild({ repo: "/c" });
    forB.resolve("b-main");
    await settle();

    expect(dialogOf(run)).toMatchObject({ repo: "/c", base: "" });
    forC.resolve("c-main");
    await settle();
    expect(dialogOf(run)).toMatchObject({ repo: "/c", base: "c-main" });
    expect(canvas.getState().flow).toBe(flowBefore);
  });

  it("leaves the base empty when the default branch cannot be read", async () => {
    const { run, bridge, canvas, flowBefore } = await opened();
    bridge.defaultBranch.mockRejectedValueOnce(new Error("/b is not a git repository"));

    run.getState().editBuild({ repo: "/b" });
    await settle();

    expect(dialogOf(run)).toMatchObject({ repo: "/b", base: "" });
    expect(canvas.getState().flow).toBe(flowBefore);
  });

  it("keeps a branch picked before the default branch answered", async () => {
    const { run, bridge, canvas, flowBefore } = await opened();
    const reply = deferred<unknown>();
    bridge.defaultBranch.mockReturnValueOnce(reply.promise);

    run.getState().editBuild({ repo: "/b" });
    run.getState().editBuild({ base: "dev" });
    reply.resolve("main");
    await settle();

    expect(dialogOf(run)).toMatchObject({ repo: "/b", base: "dev" });
    expect(canvas.getState().flow).toBe(flowBefore);
  });
});

describe("the Build dialog's branch", () => {
  const opened = async (
    branches: string[] = ["main", "feat-y", "flowdeck/fix-login"],
    checkedOut: Record<string, string> = { main: "/code/shop" },
  ) => {
    const ready = await setup({ branches, checkedOut, built: configured(shopRepo) });
    await ready.run.getState().openBuild(fromCard);
    return ready;
  };

  const dialogOf = (run: Awaited<ReturnType<typeof opened>>["run"]) => run.getState().buildDialog;

  it("opens on a new branch named by the recommendation for the build name and the repository's local branches", async () => {
    const { run, bridge } = await opened();

    expect(bridge.listBranches).toHaveBeenCalledWith({ repo: "/code/shop" });
    expect(bridge.checkedOutBranches).toHaveBeenCalledWith({ repo: "/code/shop" });
    expect(dialogOf(run)).toMatchObject({
      branchMode: "new",
      branchName: recommendedBranch("", ["main", "feat-y", "flowdeck/fix-login"]),
      branchNameEdited: false,
    });
  });

  it("follows the build name with the recommendation, past a branch that exists", async () => {
    const { run } = await opened();

    run.getState().editBuild({ name: "fix-login" });
    expect(dialogOf(run)?.branchName).toBe("flowdeck/fix-login-2");
    run.getState().editBuild({ name: "fix-signup" });
    expect(dialogOf(run)?.branchName).toBe("flowdeck/fix-signup");
  });

  it.each([
    ["an edited name", "mine"],
    ["a cleared name", ""],
  ])("stops following the build name after %s", async (_case, edited) => {
    const { run } = await opened();
    run.getState().editBuild({ name: "fix-signup" });

    run.getState().editBuild({ branchName: edited });
    run.getState().editBuild({ name: "fix-logout" });

    expect(dialogOf(run)).toMatchObject({ branchName: edited, branchNameEdited: true });
  });

  it("cannot build on a new branch whose name is not a valid branch name", async () => {
    const { run } = await opened();
    run.getState().editBuild({ name: "fix-signup" });
    run.getState().setValue("ticket", "FD-1");
    expect(selectCanBuild(run.getState())).toBe(true);

    run.getState().editBuild({ branchName: "fix..login" });
    expect(selectCanBuild(run.getState())).toBe(false);
    run.getState().editBuild({ branchName: "" });
    expect(selectCanBuild(run.getState())).toBe(false);
    run.getState().editBuild({ branchName: "flowdeck/fix-signup" });
    expect(selectCanBuild(run.getState())).toBe(true);
  });

  it("lists the local branches to build on, each checked-out one disabled with where it is checked out", async () => {
    const { run } = await opened(["main", "feat-y", "feat-z"], {
      main: "/code/shop",
      "feat-z": "/work/feat-z",
    });

    expect(selectExistingBranches(run.getState())).toEqual([
      { name: "main", reason: "Checked out in /code/shop" },
      { name: "feat-y", reason: null },
      { name: "feat-z", reason: "Checked out in /work/feat-z" },
    ]);
  });

  it("cannot build on an existing branch until one that is not checked out is chosen", async () => {
    const { run } = await opened();
    run.getState().editBuild({ name: "fix-signup" });
    run.getState().setValue("ticket", "FD-1");
    const canBuild = () => selectCanBuild(run.getState());

    run.getState().editBuild({ branchMode: "existing" });
    expect(canBuild()).toBe(false);
    run.getState().editBuild({ existingBranch: "main" });
    expect(canBuild()).toBe(false);
    run.getState().editBuild({ existingBranch: "feat-y" });
    expect(canBuild()).toBe(true);
  });

  it("cannot build on an existing branch when every local branch is checked out", async () => {
    const { run } = await opened(["main", "feat-y"], {
      main: "/code/shop",
      "feat-y": "/work/feat-y",
    });
    run.getState().editBuild({ name: "fix-signup", branchMode: "existing" });
    run.getState().setValue("ticket", "FD-1");

    expect(selectExistingBranches(run.getState()).every(({ reason }) => reason !== null)).toBe(
      true,
    );
    expect(selectCanBuild(run.getState())).toBe(false);
  });

  it("builds on the new branch it names, cut from the base", async () => {
    const { run, bridge } = await opened();
    run.getState().editBuild({ name: "fix-signup", base: "dev", branchName: "flowdeck/signup" });
    run.getState().setValue("ticket", "FD-1");

    await run.getState().confirmBuild();

    expect(bridge.buildVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "dev",
        branch: { mode: "new", name: "flowdeck/signup", base: "dev" },
      }),
    );
  });

  it("can build on a free existing branch before the base is known", async () => {
    const { run, bridge } = await opened();
    run.getState().editBuild({
      name: "fix-signup",
      base: "",
      branchMode: "existing",
      existingBranch: "feat-y",
    });
    run.getState().setValue("ticket", "FD-1");

    expect(selectCanBuild(run.getState())).toBe(true);
    await run.getState().confirmBuild();

    expect(bridge.buildVersion).toHaveBeenCalledWith(
      expect.not.objectContaining({ base: expect.anything() }),
    );
  });

  it("builds on the existing branch chosen, still sending the base", async () => {
    const { run, bridge } = await opened();
    run
      .getState()
      .editBuild({ name: "fix-signup", branchMode: "existing", existingBranch: "feat-y" });
    run.getState().setValue("ticket", "FD-1");

    await run.getState().confirmBuild();

    expect(bridge.buildVersion).toHaveBeenCalledWith(
      expect.objectContaining({ base: "main", branch: { mode: "existing", name: "feat-y" } }),
    );
  });

  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("reads the branches of a new repository, dropping the chosen branch, and recommends against them", async () => {
    const { run, bridge } = await opened();
    run
      .getState()
      .editBuild({ name: "fix-login", branchMode: "existing", existingBranch: "feat-y" });
    bridge.listBranches.mockResolvedValueOnce([
      "trunk",
      "flowdeck/fix-login",
      "flowdeck/fix-login-2",
    ]);
    bridge.checkedOutBranches.mockResolvedValueOnce({ trunk: "/code/other" });

    run.getState().editBuild({ repo: "/code/other" });
    expect(dialogOf(run)).toMatchObject({ branches: [], checkedOut: {}, existingBranch: null });
    await settle();

    expect(bridge.listBranches).toHaveBeenLastCalledWith({ repo: "/code/other" });
    expect(bridge.checkedOutBranches).toHaveBeenLastCalledWith({ repo: "/code/other" });
    expect(selectExistingBranches(run.getState())).toEqual([
      { name: "trunk", reason: "Checked out in /code/other" },
      { name: "flowdeck/fix-login", reason: null },
      { name: "flowdeck/fix-login-2", reason: null },
    ]);
    expect(dialogOf(run)?.branchName).toBe("flowdeck/fix-login-3");
  });

  it("ignores the branches of a repository that was replaced before they arrived", async () => {
    const { run, bridge } = await opened();
    const forB = deferred<unknown>();
    bridge.listBranches.mockReturnValueOnce(forB.promise).mockResolvedValueOnce(["c-main"]);

    run.getState().editBuild({ repo: "/b" });
    run.getState().editBuild({ repo: "/c" });
    await settle();
    forB.resolve(["b-main"]);
    await settle();

    expect(dialogOf(run)).toMatchObject({ repo: "/c", branches: ["c-main"] });
  });

  it("opens offering no branches to pick, and the plain recommendation, when the repository's branches cannot be read", async () => {
    const { run, bridge } = await setup({
      branches: ["main", "flowdeck/fix-login"],
      built: configured(shopRepo),
    });
    bridge.checkedOutBranches.mockRejectedValueOnce(
      new Error("/code/shop is not a git repository"),
    );

    await run.getState().openBuild(fromCard);
    run.getState().editBuild({ name: "fix-login" });

    expect(dialogOf(run)).toMatchObject({
      repo: "/code/shop",
      branches: [],
      checkedOut: {},
      branchName: "flowdeck/fix-login",
    });
  });
});

describe("needsSessionSetup", () => {
  it("is true when a problem is about a container's setting", () => {
    expect(
      needsSessionSetup([
        { container: "session-1", field: "repo", text: "Choose the repository." },
      ]),
    ).toBe(true);
  });

  it("is false for a field problem that names no container", () => {
    expect(needsSessionSetup([{ field: "buildConfig.repo", text: "Choose the repository." }])).toBe(
      false,
    );
  });

  it("is false for node problems and for no problems", () => {
    expect(needsSessionSetup([{ node: "P", field: "instructions", text: "Write it." }])).toBe(
      false,
    );
    expect(needsSessionSetup(null)).toBe(false);
  });
});

describe("runBuild", () => {
  it("runs the build by its id without saving or building, when it offers no auto mode", async () => {
    const { bridge, canvas, run, calls } = await setup();
    makeDirty(canvas);

    await expect(run.getState().runBuild("b-1")).resolves.toBe("run-1");

    expect(bridge.runOptions).toHaveBeenCalledWith({ buildId: "b-1" });
    expect(bridge.runBuild).toHaveBeenCalledWith({ buildId: "b-1" });
    expect(calls).toEqual(["runBuild"]);
    expect(run.getState().dialog).toBeNull();
  });

  it("asks only for auto mode when the build offers it, then starts with that choice", async () => {
    const { bridge, run } = await setup({ automatic: true });

    await expect(run.getState().runBuild("b-1")).resolves.toBeNull();

    expect(bridge.runBuild).not.toHaveBeenCalled();
    expect(run.getState().dialog).toEqual({ buildId: "b-1" });

    await expect(run.getState().start({ auto: true })).resolves.toBe("run-1");

    expect(bridge.runBuild).toHaveBeenCalledWith({ buildId: "b-1", auto: true });
    expect(run.getState().dialog).toBeNull();
  });

  it("cancel closes the run dialog without a run", async () => {
    const { bridge, run } = await setup({ automatic: true });
    await run.getState().runBuild("b-1");

    run.getState().cancelDialog();

    expect(run.getState().dialog).toBeNull();
    expect(bridge.runBuild).not.toHaveBeenCalled();
  });

  it("holds the reason the run options refuse a build, without asking for options or starting it", async () => {
    const { bridge, run } = await setup();
    bridge.runOptions.mockResolvedValueOnce({
      kind: "error",
      message: "Running several sessions is not supported yet.",
    });

    await expect(run.getState().runBuild("b-1")).resolves.toBeNull();

    expect(run.getState().error).toBe("Running several sessions is not supported yet.");
    expect(run.getState().dialog).toBeNull();
    expect(bridge.runBuild).not.toHaveBeenCalled();
  });

  it("holds the message of a refused run, and clears it once a run starts", async () => {
    const { bridge, run } = await setup();
    bridge.runBuild.mockResolvedValueOnce({
      kind: "error",
      message: "A run of this build is already in progress",
    });

    await expect(run.getState().runBuild("b-1")).resolves.toBeNull();
    expect(run.getState().error).toBe("A run of this build is already in progress");

    await run.getState().runBuild("b-1");
    expect(run.getState().error).toBeNull();
  });

  it("holds an error when runBuild answers with something that is not a start result", async () => {
    const { bridge, run } = await setup();
    bridge.runBuild.mockResolvedValueOnce({ kind: "begun" });

    await run.getState().runBuild("b-1");

    expect(run.getState().error).toEqual(expect.any(String));
    expect(run.getState().error).not.toBe("");
  });

  it("starts another build while one is running", async () => {
    const { bridge, run, push } = await setup();
    await run.getState().connect();
    push(snapshot("running", {}, "run-1"));
    bridge.runBuild.mockResolvedValueOnce({ kind: "started", runId: "run-2" });

    await expect(run.getState().runBuild("b-2")).resolves.toBe("run-2");
  });

  it("does nothing while a run is starting", async () => {
    const { bridge, run } = await setup();
    const answer = deferred<unknown>();
    bridge.runBuild.mockReturnValueOnce(answer.promise);

    const first = run.getState().runBuild("b-1");
    await vi.waitFor(() => expect(bridge.runBuild).toHaveBeenCalledTimes(1));

    expect(run.getState().starting).toBe(true);
    await expect(run.getState().runBuild("b-2")).resolves.toBeNull();
    expect(bridge.runBuild).toHaveBeenCalledTimes(1);

    answer.resolve({ kind: "started", runId: "run-1" });
    await first;
    expect(run.getState().starting).toBe(false);
  });
});

describe("selectRunDisabled", () => {
  it("is false for a build that has never run, or whose last run ended", async () => {
    const { run } = await setup();

    expect(selectRunDisabled(run.getState(), card())).toBe(false);
    expect(selectRunDisabled(run.getState(), card({ id: "run-1", status: "done" }))).toBe(false);
    expect(selectRunDisabled(run.getState(), card({ id: "run-1", status: "stopped" }))).toBe(false);
  });

  it("is true while the build's run is running or interrupted", async () => {
    const { run } = await setup();

    expect(selectRunDisabled(run.getState(), card({ id: "run-1", status: "running" }))).toBe(true);
    expect(selectRunDisabled(run.getState(), card({ id: "run-1", status: "interrupted" }))).toBe(
      true,
    );
  });

  it("follows the live snapshot of the build's run over its listed status", async () => {
    const { run, push } = await setup();
    await run.getState().connect();

    push(snapshot("running", {}, "run-1"));
    expect(selectRunDisabled(run.getState(), card({ id: "run-1", status: "done" }))).toBe(true);
    expect(selectRunDisabled(run.getState(), card({ id: "run-2", status: "done" }))).toBe(false);

    push(snapshot("done", {}, "run-1"));
    expect(selectRunDisabled(run.getState(), card({ id: "run-1", status: "running" }))).toBe(false);
  });

  it("is true for an old build, which says to make a new build", async () => {
    const { run } = await setup();

    expect(selectRunDisabled(run.getState(), card(null, true))).toBe(true);
    expect(selectRunHint({ old: true, blueprint: "review" })).toBe(
      "Make a new build from this blueprint",
    );
    expect(selectRunHint({ old: false, blueprint: "review" })).toBeNull();
  });

  it("does not point an old build with no blueprint at one", () => {
    expect(selectRunHint({ old: true, blueprint: "" })).toBe(
      "Builds from before named builds can't run again.",
    );
    expect(selectRunHint({ old: false, blueprint: "" })).toBeNull();
  });

  it("is true for every build while a run is starting", async () => {
    const { bridge, run } = await setup();
    const answer = deferred<unknown>();
    bridge.runBuild.mockReturnValueOnce(answer.promise);
    const first = run.getState().runBuild("b-1");
    await vi.waitFor(() => expect(bridge.runBuild).toHaveBeenCalledTimes(1));

    expect(selectRunDisabled(run.getState(), card())).toBe(true);

    answer.resolve({ kind: "started", runId: "run-1" });
    await first;
    expect(selectRunDisabled(run.getState(), card())).toBe(false);
  });
});

describe("deleteBuild", () => {
  it("deletes the build by its id and shows nothing kept when nothing was", async () => {
    const { bridge, run } = await setup();

    await expect(run.getState().deleteBuild("b-1")).resolves.toBe(true);

    expect(bridge.deleteBuild).toHaveBeenCalledWith({ buildId: "b-1" });
    expect(run.getState()).toMatchObject({ kept: null, error: null });
  });

  it.each([
    [{ kind: "worktree", path: "/fd/workspaces/b-1/shop" }],
    [{ kind: "branch", branch: "flowdeck/fix-login-b1" }],
    [{ kind: "folder", path: "/elsewhere/builds/oldhash" }],
  ] as const)("holds what it kept, %j, with the build id", async (kept) => {
    const { bridge, run } = await setup();
    bridge.deleteBuild.mockResolvedValueOnce({ ok: true, kept: [kept] });

    await run.getState().deleteBuild("b-1");

    expect(run.getState().kept).toEqual([{ buildId: "b-1", ...kept }]);
  });

  it.each([
    [
      { kind: "worktree", path: "/fd/workspaces/b-1/shop" },
      "The build is deleted. Its worktree held work, so it was kept at /fd/workspaces/b-1/shop",
    ],
    [
      { kind: "branch", branch: "flowdeck/fix-login-b1" },
      "The build is deleted. Its branch flowdeck/fix-login-b1 holds commits, so it was kept.",
    ],
    [
      { kind: "branch", branch: "flowdeck/fix-login-b1", reason: "open-pr" },
      "The build is deleted. Its branch flowdeck/fix-login-b1 was kept: an open pull request uses it.",
    ],
    [
      { kind: "branch", branch: "flowdeck/fix-login-b1", reason: "pr-unknown" },
      "The build is deleted. Its branch flowdeck/fix-login-b1 was kept: its pull request status could not be checked.",
    ],
    [
      {
        kind: "branch",
        branch: "flowdeck/fix-login-b1",
        reason: "remote-moved",
        remotes: ["origin", "mirror"] as string[],
      },
      "The build is deleted. Its branch flowdeck/fix-login-b1 on origin, mirror has work this build didn't make, so it was kept.",
    ],
    [
      { kind: "branch", branch: "flowdeck/fix-login-b1", reason: "remote-delete-failed" },
      "The build is deleted. Its branch flowdeck/fix-login-b1 on GitHub could not be deleted.",
    ],
    [
      { kind: "folder", path: "/elsewhere/builds/oldhash" },
      "The build is deleted. Its folder /elsewhere/builds/oldhash is outside FLOWDECK_HOME, so it was left in place.",
    ],
  ] as const)("words what it kept, %j, by why it was kept", (kept, note) => {
    expect(selectKeptNote({ buildId: "b-1", ...kept })).toBe(note);
  });

  it("words every worktree a delete kept, one note each", async () => {
    const { bridge, run } = await setup();
    bridge.deleteBuild.mockResolvedValueOnce({
      ok: true,
      kept: [
        { kind: "worktree", path: "/fd/workspaces/b-1/sessions/android/android" },
        { kind: "worktree", path: "/fd/workspaces/b-1/sessions/ios/ios" },
      ],
    });

    await run.getState().deleteBuild("b-1");

    expect(selectKeptNotes(run.getState())).toEqual([
      "The build is deleted. Its worktree held work, so it was kept at /fd/workspaces/b-1/sessions/android/android",
      "The build is deleted. Its worktree held work, so it was kept at /fd/workspaces/b-1/sessions/ios/ios",
    ]);
  });

  it("holds the refusal and keeps nothing when the build cannot be deleted", async () => {
    const { bridge, run } = await setup();
    bridge.deleteBuild.mockResolvedValueOnce({ ok: false, message: "A run of b-1 is going" });

    await expect(run.getState().deleteBuild("b-1")).resolves.toBe(false);

    expect(run.getState()).toMatchObject({ kept: null, error: "A run of b-1 is going" });
  });
});

describe("the ⋯ menu", () => {
  it("keeps one menu open at a time, the last one opened, until it is closed", async () => {
    const { run } = await setup();
    expect(run.getState().menuOpen).toBeNull();

    run.getState().openMenu("build:b-1");
    expect(run.getState().menuOpen).toBe("build:b-1");

    run.getState().openMenu("run:run-2");
    expect(run.getState().menuOpen).toBe("run:run-2");

    run.getState().closeMenu();
    expect(run.getState().menuOpen).toBeNull();
  });
});

describe("confirming a delete", () => {
  it("loads what deleting a build would lose into its confirm", async () => {
    const { bridge, run } = await setup();
    bridge.deletePreview.mockResolvedValueOnce({ dirtyWorktree: true, unpushedBranch: false });

    await run.getState().askDelete({ kind: "build", id: "b-1" });

    expect(bridge.deletePreview).toHaveBeenCalledExactlyOnceWith({ buildId: "b-1" });
    expect(run.getState().confirmingDelete).toEqual({
      kind: "build",
      id: "b-1",
      preview: { dirtyWorktree: true, unpushedBranch: false },
    });
  });

  it("opens no confirm for a build whose loss cannot be read, holding the error instead", async () => {
    const { bridge, run } = await setup();
    bridge.deletePreview.mockRejectedValueOnce(new Error("No build b-1"));

    await run.getState().askDelete({ kind: "build", id: "b-1" });

    expect(run.getState().confirmingDelete).toBeNull();
    expect(run.getState().error).toBe("No build b-1");
  });

  it("loads what deleting a pending build would lose into its confirm", async () => {
    const { bridge, run } = await setup();
    bridge.deletePendingPreview.mockResolvedValueOnce({
      dirtyWorktree: false,
      unpushedBranch: true,
    });

    await run.getState().askDelete({ kind: "pending", id: "pb-1" });

    expect(bridge.deletePendingPreview).toHaveBeenCalledExactlyOnceWith({ id: "pb-1" });
    expect(bridge.deletePreview).not.toHaveBeenCalled();
    expect(run.getState().confirmingDelete).toEqual({
      kind: "pending",
      id: "pb-1",
      preview: { dirtyWorktree: false, unpushedBranch: true },
    });
  });

  it("opens no confirm for a pending build whose loss cannot be read, holding the error instead", async () => {
    const { bridge, run } = await setup();
    bridge.deletePendingPreview.mockRejectedValueOnce(new Error("No pending build pb-1"));

    await run.getState().askDelete({ kind: "pending", id: "pb-1" });

    expect(run.getState().confirmingDelete).toBeNull();
    expect(run.getState().error).toBe("No pending build pb-1");
  });

  it.each([
    [{ kind: "run", id: "run-2", from: "runs" }],
    [{ kind: "run", id: "run-2", from: "run-page" }],
  ] as const)("asks to confirm %j without a preview", async (question) => {
    const { bridge, run } = await setup();

    await run.getState().askDelete(question);

    expect(run.getState().confirmingDelete).toEqual(question);
    expect(bridge.deletePreview).not.toHaveBeenCalled();
    expect(bridge.deletePendingPreview).not.toHaveBeenCalled();
  });

  it.each([
    [{ dirtyWorktree: true, unpushedBranch: false }, true],
    [{ dirtyWorktree: false, unpushedBranch: true }, true],
    [{ dirtyWorktree: false, unpushedBranch: false }, false],
  ] as const)("warns a build or pending delete loses work for %j: %s", (preview, warns) => {
    expect(losesWork({ kind: "build", id: "b-1", preview })).toBe(warns);
    expect(losesWork({ kind: "pending", id: "pb-1", preview })).toBe(warns);
  });

  it("lists every worktree a build delete would remove, flagging the one that loses work", async () => {
    const { bridge, run } = await setup();
    bridge.deletePreview.mockResolvedValueOnce({
      dirtyWorktree: true,
      unpushedBranch: false,
      worktrees: [
        {
          path: "/fd/workspaces/b-1/sessions/android/android",
          branch: "flowdeck/fix-login-android",
          dirtyWorktree: true,
          unpushedBranch: false,
        },
        {
          path: "/fd/workspaces/b-1/sessions/ios/ios",
          branch: "flowdeck/fix-login-ios",
          dirtyWorktree: false,
          unpushedBranch: false,
        },
      ],
    });

    await run.getState().askDelete({ kind: "build", id: "b-1" });
    const question = run.getState().confirmingDelete;

    expect(question === null ? null : selectDeleteWorktrees(question)).toEqual([
      {
        path: "/fd/workspaces/b-1/sessions/android/android",
        branch: "flowdeck/fix-login-android",
        losesWork: true,
      },
      {
        path: "/fd/workspaces/b-1/sessions/ios/ios",
        branch: "flowdeck/fix-login-ios",
        losesWork: false,
      },
    ]);
  });

  it("lists no worktree for a run delete", () => {
    expect(selectDeleteWorktrees({ kind: "run", id: "run-2", from: "runs" })).toEqual([]);
  });

  it("never warns a run delete loses work", () => {
    expect(losesWork({ kind: "run", id: "run-2", from: "runs" })).toBe(false);
  });

  it("cancel clears the confirm and deletes nothing", async () => {
    const { bridge, run } = await setup();
    await run.getState().askDelete({ kind: "build", id: "b-1" });

    run.getState().cancelDelete();

    expect(run.getState().confirmingDelete).toBeNull();
    expect(bridge.deleteBuild).not.toHaveBeenCalled();
    expect(bridge.deleteRun).not.toHaveBeenCalled();
    expect(bridge.deletePendingBuild).not.toHaveBeenCalled();
  });
});

describe("deleteRun", () => {
  it("deletes the run by its id and stops pointing the status bar at it", async () => {
    const { bridge, run, push } = await setup();
    await run.getState().connect();
    push(snapshot("running", { a: "running" }, "run-1"));

    await expect(run.getState().deleteRun("run-1")).resolves.toBe(true);

    expect(bridge.deleteRun).toHaveBeenCalledExactlyOnceWith({ runId: "run-1" });
    expect(run.getState().latestRunId).toBeNull();
    expect(run.getState().error).toBeNull();
  });

  it("answers that nothing was deleted and holds the engine's refusal as the error", async () => {
    const { bridge, run, push } = await setup();
    await run.getState().connect();
    push(snapshot("running", { a: "running" }, "run-1"));
    bridge.deleteRun.mockRejectedValueOnce(new Error("Unknown run run-1"));

    await expect(run.getState().deleteRun("run-1")).resolves.toBe(false);

    expect(run.getState().error).toBe("Unknown run run-1");
    expect(run.getState().latestRunId).toBe("run-1");
  });

  it("keeps the latest run when another run is deleted", async () => {
    const { run, push } = await setup();
    await run.getState().connect();
    push(snapshot("running", { a: "running" }, "run-1"));

    await run.getState().deleteRun("run-2");

    expect(run.getState().latestRunId).toBe("run-1");
  });
});

describe("deletePendingBuild", () => {
  it("deletes the build that never finished by its id and answers that it did", async () => {
    const { bridge, run } = await setup();

    await expect(run.getState().deletePendingBuild("pb-1")).resolves.toBe(true);

    expect(bridge.deletePendingBuild).toHaveBeenCalledExactlyOnceWith({ id: "pb-1" });
    expect(run.getState().error).toBeNull();
  });

  it("answers that nothing was deleted and holds the engine's refusal as the error", async () => {
    const { bridge, run } = await setup();
    bridge.deletePendingBuild.mockRejectedValueOnce(new Error("Unknown pending build pb-1"));

    await expect(run.getState().deletePendingBuild("pb-1")).resolves.toBe(false);

    expect(run.getState().error).toBe("Unknown pending build pb-1");
  });
});

describe("writeStory", () => {
  it("marks the run writing while its story is written, sending one request while one is in flight", async () => {
    const { bridge, run } = await setup();
    const answer = deferred<unknown>();
    bridge.writeStory.mockReturnValueOnce(answer.promise);

    const first = run.getState().writeStory("run-1");
    expect(run.getState().isWritingStory("run-1")).toBe(true);
    expect(run.getState().isWritingStory("run-2")).toBe(false);
    await run.getState().writeStory("run-1");

    answer.resolve({ ok: true });
    await first;

    expect(bridge.writeStory).toHaveBeenCalledExactlyOnceWith({ runId: "run-1" });
    expect(run.getState().isWritingStory("run-1")).toBe(false);
    expect(run.getState().storyErrorFor("run-1")).toBeUndefined();
  });

  it("holds the error the engine answers as the run's write error, and clears it once a story is written", async () => {
    const { bridge, run } = await setup();
    bridge.writeStory.mockResolvedValueOnce({ ok: false, error: "narrator down" });

    await run.getState().writeStory("run-1");

    expect(run.getState().isWritingStory("run-1")).toBe(false);
    expect(run.getState().storyErrorFor("run-1")).toBe("narrator down");
    expect(run.getState().storyErrorFor("run-2")).toBeUndefined();

    await run.getState().writeStory("run-1");

    expect(run.getState().storyErrorFor("run-1")).toBeUndefined();
  });

  it("holds a failed request as the run's write error and stops writing", async () => {
    const { bridge, run } = await setup();
    bridge.writeStory.mockRejectedValueOnce(new Error("engine gone"));

    await run.getState().writeStory("run-1");

    expect(run.getState().isWritingStory("run-1")).toBe(false);
    expect(run.getState().storyErrorFor("run-1")).toBe("engine gone");
  });
});

describe("controls", () => {
  it("stops, retries and resumes a run through the bridge", async () => {
    const { bridge, run } = await setup();

    await run.getState().stop("run-7");
    await expect(run.getState().retry("run-7", "s1")).resolves.toBe("run-7");
    await expect(run.getState().resume("run-7")).resolves.toBe("run-7");

    expect(bridge.stopRun).toHaveBeenCalledWith({ runId: "run-7" });
    expect(bridge.retryNode).toHaveBeenCalledWith({ runId: "run-7", nodeId: "s1" });
    expect(bridge.resumeRun).toHaveBeenCalledWith({ runId: "run-7" });
  });

  it("stops an interrupted run, with no live snapshot of it", async () => {
    const { bridge, run } = await setup();

    await run.getState().stop("run-interrupted");

    expect(bridge.stopRun).toHaveBeenCalledWith({ runId: "run-interrupted" });
    expect(run.getState().error).toBeNull();
  });

  it("holds the message when a retry or resume is refused", async () => {
    const { bridge, run } = await setup();
    bridge.resumeRun.mockResolvedValueOnce({ kind: "error", message: "nope" });

    await expect(run.getState().resume("run-7")).resolves.toBeNull();

    expect(run.getState().error).toBe("nope");
  });

  it("keeps the cost report of the run it was asked for", async () => {
    const { run } = await setup();

    await run.getState().loadCost("run-7");

    expect(run.getState().cost).toEqual({
      runId: "run-7",
      report: {
        nodes: [{ nodeId: "p1", tokens: 10, cost: 0.5, ms: 1000 }],
        total: { tokens: 10, cost: 0.5, ms: 1000 },
      },
    });
  });

  it("refreshes a live run's pipeline and cost together while nothing else changes", async () => {
    const { bridge, run, tick } = await setup();
    await run.getState().loadPipeline("run-7");
    await run.getState().loadCost("run-7");
    bridge.runPipeline.mockResolvedValue(inWorkspace({ ...stage("p1"), cost: 0.0042 }));
    bridge.runCost.mockResolvedValue({
      nodes: [{ nodeId: "p1", tokens: 12, cost: 0.0042, ms: 1000 }],
      total: { tokens: 12, cost: 0.0042, ms: 1000 },
    });

    run.getState().watchCost("run-7");
    await tick();

    expect(run.getState().pipelines["run-7"]?.[0]?.items[0]).toMatchObject({
      nodeId: "p1",
      cost: 0.0042,
    });
    expect(run.getState().cost?.report.nodes[0]?.cost).toBe(0.0042);
  });

  it("refreshes a run once per tick however many views watch it, until the last stops", async () => {
    const { bridge, run, tick } = await setup();
    const stopPipeline = run.getState().watchCost("run-7");
    const stopCostTab = run.getState().watchCost("run-7");

    await tick();
    expect(bridge.runPipeline).toHaveBeenCalledTimes(1);

    stopCostTab();
    await tick();
    expect(bridge.runPipeline).toHaveBeenCalledTimes(2);

    stopPipeline();
    await tick();
    expect(bridge.runPipeline).toHaveBeenCalledTimes(2);
  });

  it("stops refreshing once the watch is ended", async () => {
    const { bridge, run, tick } = await setup();
    const stop = run.getState().watchCost("run-7");
    await tick();
    const pipelineCalls = bridge.runPipeline.mock.calls.length;
    const costCalls = bridge.runCost.mock.calls.length;

    stop();
    await tick();

    expect(pipelineCalls).toBeGreaterThan(0);
    expect(bridge.runPipeline).toHaveBeenCalledTimes(pipelineCalls);
    expect(bridge.runCost).toHaveBeenCalledTimes(costCalls);
  });

  it("keeps the round lines of a cost report", async () => {
    const { bridge, run } = await setup();
    const report = {
      nodes: [
        {
          nodeId: "body",
          tokens: 30,
          cost: 0.9,
          ms: 2000,
          rounds: [
            { round: 1, tokens: 10, cost: 0.2 },
            { round: 2, tokens: 20, cost: 0.7 },
          ],
        },
      ],
      total: { tokens: 30, cost: 0.9, ms: 2000 },
    };
    bridge.runCost.mockResolvedValueOnce(report);

    await run.getState().loadCost("run-7");

    expect(run.getState().cost).toEqual({ runId: "run-7", report });
  });
});

describe("the run pipeline", () => {
  it("keeps the cost of each round of a loop", async () => {
    const { bridge, run } = await setup();
    const loop = {
      ...stage("rounds"),
      type: "loop",
      label: "Until done",
      rounds: [
        { round: 1, tokens: 10, cost: 0.2, items: [{ ...stage("body"), cost: 0.2 }] },
        { round: 2, tokens: 20, cost: 0.7, items: [{ ...stage("body"), tokens: 20, cost: 0.7 }] },
      ],
    };
    bridge.runPipeline.mockResolvedValueOnce(inWorkspace(loop));

    await run.getState().loadPipeline("run-7");

    expect(run.getState().pipelines["run-7"]).toEqual(inWorkspace(loop));
  });

  it("keeps the pipeline the engine answers under each run it was asked for", async () => {
    const { bridge, run } = await setup();
    bridge.runPipeline.mockResolvedValueOnce(inWorkspace(stage("a1")));
    bridge.runPipeline.mockResolvedValueOnce(inWorkspace(stage("b1")));

    await run.getState().loadPipeline("run-7");
    await run.getState().loadPipeline("run-8");

    expect(bridge.runPipeline).toHaveBeenNthCalledWith(1, { runId: "run-7" });
    expect(bridge.runPipeline).toHaveBeenNthCalledWith(2, { runId: "run-8" });
    expect(run.getState().pipelines).toEqual({
      "run-7": inWorkspace(stage("a1")),
      "run-8": inWorkspace(stage("b1")),
    });
  });

  it("keeps a run whose stages were not recorded as no pipeline", async () => {
    const { bridge, run } = await setup();
    bridge.runPipeline.mockResolvedValueOnce(null);

    await run.getState().loadPipeline("run-7");

    expect(run.getState().pipelines).toHaveProperty("run-7", null);
  });

  it("replaces a run's pipeline with the newer answer", async () => {
    const { bridge, run } = await setup();
    bridge.runPipeline.mockResolvedValueOnce(inWorkspace(stage("a1")));
    bridge.runPipeline.mockResolvedValueOnce(inWorkspace(stage("a1"), stage("a2")));

    await run.getState().loadPipeline("run-7");
    await run.getState().loadPipeline("run-7");

    expect(run.getState().pipelines["run-7"]).toEqual(inWorkspace(stage("a1"), stage("a2")));
  });

  it("holds the message and keeps the pipeline it had when the engine refuses", async () => {
    const { bridge, run } = await setup();
    await run.getState().loadPipeline("run-7");
    bridge.runPipeline.mockRejectedValueOnce(new Error("No run run-7"));

    await run.getState().loadPipeline("run-7");

    expect(run.getState().error).toBe("No run run-7");
    expect(run.getState().pipelines["run-7"]).toEqual(inWorkspace(stage("a1")));
  });
});

describe("a run with session containers", () => {
  const node = (nodeId: string, label: string, status: NodeState) => ({
    ...stage(nodeId),
    label,
    status,
  });

  const loaded = async (groups: unknown[], runId = "run-7") => {
    const context = await setup();
    context.bridge.runPipeline.mockResolvedValueOnce(groups);
    await context.run.getState().loadPipeline(runId);
    return context;
  };

  it("keeps android's stages under android, and shows them with their display", async () => {
    const groups = [
      group("workspace", "running", [node("ws-start", "Start", "done")]),
      group("android", "running", [node("android-a1", "Build", "running")]),
    ];
    const { run } = await loaded(groups);
    const view = {
      snapshot: snapshot("running", { "ws-start": "done", "android-a1": "running" }, "run-7"),
      pipeline: run.getState().pipelines["run-7"] ?? null,
    };

    expect(run.getState().pipelines["run-7"]).toEqual(groups);
    expect(selectNodeDisplay(view, "android-a1")).toBe("running");
  });

  it("shows a container with no first event as not started once the run ends", async () => {
    const groups = [
      group("workspace", "done", [node("ws-wait", "Wait", "waiting")]),
      group("android", "not-started", [node("android-a1", "Build", "waiting")]),
    ];
    const { run } = await loaded(groups);
    const view = {
      snapshot: snapshot("done", { "ws-wait": "waiting", "android-a1": "waiting" }, "run-7"),
      pipeline: run.getState().pipelines["run-7"] ?? null,
    };

    expect(run.getState().pipelines["run-7"]?.[1]?.status).toBe("not-started");
    expect(selectNodeDisplay(view, "android-a1")).toBe("not-started");
    expect(selectNodeDisplay(view, "ws-wait")).toBe("waiting");
  });

  it("names the container and node of a failed session", async () => {
    const { run } = await loaded([
      group("workspace", "done", [node("ws-start", "Start", "done")]),
      group("android", "failed", [node("android-a1", "Build", "failed")]),
    ]);

    expect(selectSessionFailure(run.getState(), "run-7")).toBe("Failed in android: Build");
  });

  it.each([
    ["no node failed", "done"],
    ["only a workspace node failed", "failed"],
  ] as const)("names no session failure when %s", async (_case, workspaceState) => {
    const { run } = await loaded([
      group("workspace", workspaceState, [node("ws-a1", "Plan", workspaceState)]),
      group("android", "done", [node("android-a1", "Build", "done")]),
    ]);

    expect(selectSessionFailure(run.getState(), "run-7")).toBeNull();
  });

  it("keeps the pushed started sessions of each run for the terminal", async () => {
    const { run, pushSessions } = await setup();
    await run.getState().connect();
    const started = [
      { container: "workspace", tmuxName: "fd-run-aaaa1111" },
      { container: "android", tmuxName: "fd-run-bbbb2222" },
    ];

    pushSessions({ runId: "run-7", sessions: started });
    pushSessions({ runId: "run-8", sessions: [started[0]] });
    pushSessions({ runId: "run-7", sessions: "fd-run-cccc3333" });

    expect(selectStartedSessions(run.getState(), "run-7")).toEqual(started);
    expect(selectStartedSessions(run.getState(), "run-8")).toEqual([started[0]]);
    expect(selectStartedSessions(run.getState(), "run-9")).toEqual([]);
  });
});

describe("selectStage", () => {
  it("selects nothing on a fresh run", async () => {
    const { run } = await setup();

    expect(run.getState().selectedStage["run-7"]).toBeUndefined();
  });

  it("keeps the selected stage, and its round, per run", async () => {
    const { run } = await setup();

    run.getState().selectStage("run-7", { nodeId: "a1" });
    run.getState().selectStage("run-8", { nodeId: "l1", round: 2 });

    expect(run.getState().selectedStage).toEqual({
      "run-7": { nodeId: "a1" },
      "run-8": { nodeId: "l1", round: 2 },
    });

    run.getState().selectStage("run-7", { nodeId: "a2" });

    expect(run.getState().selectedStage["run-7"]).toEqual({ nodeId: "a2" });
    expect(run.getState().selectedStage["run-8"]).toEqual({ nodeId: "l1", round: 2 });
  });
});

describe("selectNodeDisplay", () => {
  it("is null before any snapshot", () => {
    expect(selectNodeDisplay({ snapshot: null }, "agent-1")).toBeNull();
  });

  it("maps each node's state to its display status, and is null for ids not in the snapshot", () => {
    const view = { snapshot: snapshot("running", { a: "sent", b: "needs-you", c: "skipped" }) };

    expect(selectNodeDisplay(view, "a")).toBe("sent");
    expect(selectNodeDisplay(view, "b")).toBe("needs you");
    expect(selectNodeDisplay(view, "c")).toBe("skipped");
    expect(selectNodeDisplay(view, "zz")).toBeNull();
  });
  it("shows a Gate left waiting as stopped once the run is stopped, and as needs you while running", () => {
    const nodes = { gate: "needs-you" } as const;

    expect(selectNodeDisplay({ snapshot: snapshot("stopped", nodes) }, "gate")).toBe("stopped");
    expect(selectNodeDisplay({ snapshot: snapshot("running", nodes) }, "gate")).toBe("needs you");
  });
});

describe("selectRunSummary", () => {
  const summaryOf = (value: ReturnType<typeof snapshot>, waiting = false) =>
    selectRunSummary({ snapshot: value }, waiting);

  it("is Idle before any snapshot", () => {
    expect(selectRunSummary({ snapshot: null })).toBe("Idle");
  });

  it("counts done nodes while running", () => {
    expect(
      summaryOf(
        snapshot("running", { a: "done", b: "done", c: "done", d: "running", e: "waiting" }),
      ),
    ).toBe("Running · 3 of 5 nodes done");
  });

  it("says Needs you when a node waits on the user", () => {
    expect(summaryOf(snapshot("running", { a: "done", b: "needs-you" }))).toBe(
      "Needs you · 1 of 2 nodes done",
    );
  });

  it("says Failed when a node failed", () => {
    expect(summaryOf(snapshot("failed", { a: "done", b: "failed" }))).toBe(
      "Failed · 1 of 2 nodes done",
    );
  });

  it("puts Needs you before Failed", () => {
    expect(summaryOf(snapshot("running", { a: "failed", b: "needs-you" }))).toBe(
      "Needs you · 0 of 2 nodes done",
    );
  });

  it("says Needs you while a wait is open, though no node shows it", () => {
    expect(summaryOf(snapshot("running", { a: "done", b: "waiting" }), true)).toBe(
      "Needs you · 1 of 2 nodes done",
    );
  });

  it("says Stopped for a stopped run", () => {
    expect(summaryOf(snapshot("stopped", { a: "done", b: "running" }))).toBe(
      "Stopped · 1 of 2 nodes done",
    );
  });

  it("reads a stopped run as stopped, though its Gate still waits on the user", () => {
    const nodes = { a: "done", gate: "needs-you" } as const;

    expect(summaryOf(snapshot("stopped", nodes))).toBe("Stopped · 1 of 2 nodes done");
    expect(summaryOf(snapshot("running", nodes))).toBe("Needs you · 1 of 2 nodes done");
  });

  it("says Done once every node is done and the run stopped running", () => {
    expect(
      summaryOf(snapshot("done", { a: "done", b: "done", c: "done", d: "done", e: "done" })),
    ).toBe("Done · 5 of 5 nodes done");
  });

  it("leaves out the nodes of a session container that never started", () => {
    const nodes = {
      "ws-start": "done",
      "ws-agent": "done",
      "ws-stop": "done",
      "android-start": "waiting",
      "android-stop": "waiting",
    } as const;
    const pipeline = [
      group("workspace", "done", [stage("ws-start"), stage("ws-agent"), stage("ws-stop")]),
      group("android", "not-started", [stage("android-start"), stage("android-stop")]),
    ];

    expect(selectRunSummary({ snapshot: snapshot("done", nodes), pipeline } as RunView)).toBe(
      "Done · 3 of 3 nodes done",
    );
  });

  it("counts the nodes of a session container that started", () => {
    const nodes = {
      "ws-start": "done",
      "ws-stop": "done",
      "android-start": "done",
      "android-stop": "waiting",
      "ios-start": "waiting",
      "ios-stop": "waiting",
    } as const;
    const pipeline = [
      group("workspace", "done", [stage("ws-start"), stage("ws-stop")]),
      group("android", "stopped", [stage("android-start"), stage("android-stop")]),
      group("ios", "not-started", [stage("ios-start"), stage("ios-stop")]),
    ];

    expect(selectRunSummary({ snapshot: snapshot("done", nodes), pipeline } as RunView)).toBe(
      "Done · 3 of 4 nodes done",
    );
  });
});

describe("selectRunSummary of a session run's snapshot", () => {
  const then = (from: string, to: string, port = "out") => ({
    kind: "then" as const,
    from: { node: from, port },
    to: { node: to, port: "in" },
  });

  const ran = (...ids: string[]): (RunEvent & { nodeId: string })[] =>
    ids.flatMap((nodeId) => [
      { nodeId, kind: "running" as const },
      { nodeId, kind: "done" as const },
    ]);

  const summaryOf = (
    session: { nodes: { id: string; type: NodeType }[]; wires: ReturnType<typeof then>[] },
    events: (RunEvent & { nodeId: string })[],
  ) =>
    selectRunSummary({
      snapshot: runSnapshot(
        { runId: "r", status: "done", nodeIds: session.nodes.map((node) => node.id), events },
        [session],
      ),
    });

  it("counts every step of a finished forked session done", () => {
    const forked = {
      nodes: [
        { id: "start", type: "trigger" as const },
        { id: "f", type: "fork" as const },
        { id: "a", type: "agent" as const },
        { id: "b", type: "agent" as const },
        { id: "j", type: "join" as const },
        { id: "c", type: "agent" as const },
        { id: "stop", type: "output" as const },
      ],
      wires: [
        then("start", "f"),
        then("f", "a"),
        then("f", "b"),
        then("a", "j"),
        then("b", "j"),
        then("j", "c"),
        then("c", "stop"),
      ],
    };

    expect(summaryOf(forked, ran("start", "a", "b", "c", "stop"))).toBe("Done · 7 of 7 nodes done");
  });

  it("does not count the skipped side of a finished Branch session", () => {
    const branched = {
      nodes: [
        { id: "start", type: "trigger" as const },
        { id: "br", type: "branch" as const },
        { id: "a", type: "agent" as const },
        { id: "ask", type: "ask" as const },
        { id: "stop", type: "output" as const },
      ],
      wires: [
        then("start", "br"),
        then("br", "a", "yes"),
        then("br", "ask", "no"),
        then("a", "stop"),
        then("ask", "stop"),
      ],
    };

    expect(summaryOf(branched, ran("start", "a", "stop"))).toBe("Done · 4 of 5 nodes done");
  });
});

describe("selectLiveBadge", () => {
  it("counts done nodes while running, says needs you first, and is null once finished", () => {
    expect(selectLiveBadge(snapshot("running", { a: "done", b: "running", c: "waiting" }))).toBe(
      "running · 1 of 3",
    );
    expect(selectLiveBadge(snapshot("running", { a: "done", b: "needs-you" }))).toBe("needs you");
    expect(selectLiveBadge(snapshot("done", { a: "done" }))).toBeNull();
    expect(selectLiveBadge(snapshot("stopped", { a: "done", gate: "needs-you" }))).toBeNull();
    expect(selectLiveBadge(null)).toBeNull();
  });
});

describe("the Build dialog for a host that uses libraries", () => {
  const library = (id: string, label: string) => ({
    id,
    type: "library",
    label,
    position: { x: 0, y: 0 },
    settings: { libraryId: "f-review", label, overrides: {} },
  });

  const host = (): Flow =>
    onMainFlow(
      [
        agent("plan", { settings: { instructions: "Say {{ticket}}." } }),
        library("lib-1", "android-app"),
      ],
      [thenWire("plan", "lib-1")],
    );

  const expandedWith = (names: string[], paths: string[]) => () => {
    const uses = names.map((name, index) =>
      agent(`use-${index}`, { settings: { instructions: `Check {{${name}}}.` } }),
    );
    return {
      flow: onMainFlow(
        uses,
        uses.slice(1).map((use, index) => thenWire(uses[index]?.id ?? "", use.id)),
      ),
      uses: paths.map((path) => ({ path, name: "Android library", kind: "node-library" })),
    };
  };

  it("asks for the canvas flow's expansion and lists its variables grouped by use", async () => {
    const { bridge, canvas, run } = await setup({
      latest: host(),
      expanded: () => ({
        flow: onMainFlow(
          [
            agent("plan", { settings: { instructions: "Say {{ticket}}." } }),
            branch("android-app.decide", "android-app.isFullScan"),
          ],
          [thenWire("plan", "android-app.decide")],
        ),
        uses: [{ path: "android-app", name: "Android library", kind: "node-library" }],
      }),
    });

    await run.getState().openBuild();

    expect(bridge.expandFlow).toHaveBeenCalledWith({ flow: canvas.getState().flow });
    expect(run.getState().buildDialog?.variables).toEqual([
      {
        name: "android-app.isFullScan",
        kind: "yes-no",
        nodeIds: ["android-app.decide"],
        group: { path: "android-app", name: "Android library" },
      },
      { name: "ticket", kind: "text", nodeIds: ["plan"] },
    ]);
    expect(run.getState().buildDialog?.values).toEqual({ "android-app.isFullScan": false });
    expect(run.getState().buildDialog?.problem).toBeNull();
  });

  it("refuses to build, naming the problem, when the expansion fails", async () => {
    const { run } = await setup({
      latest: host(),
      expanded: () => ({ problem: "android-app names a library that does not exist" }),
    });

    await run.getState().openBuild();

    expect(run.getState().buildDialog?.problem).toBe(
      "android-app names a library that does not exist",
    );
    expect(selectBuildRefusal(run.getState())).toBe(
      "android-app names a library that does not exist",
    );
    run.getState().editBuild({ name: "x" });
    expect(selectCanBuild(run.getState())).toBe(false);
  });

  it("targets the sessions of the expanded version, the library's sessions too", async () => {
    const ownSession = flow(
      [trigger("s"), agent("a"), output("t"), library("lib-1", "ios-app")],
      [thenWire("s", "a"), thenWire("a", "t")],
      flowSettings,
      { containers: [sessionContainer(["s", "a", "t"], { repo: "/code/shop", branch: "dev" })] },
    );
    const withLibrarySession = flow(
      [trigger("s"), agent("a"), output("t"), trigger("i-s"), output("i-t")],
      [thenWire("s", "a"), thenWire("a", "t"), thenWire("i-s", "i-t")],
      flowSettings,
      {
        containers: [
          sessionContainer(["s", "a", "t"], { repo: "/code/shop", branch: "dev" }),
          sessionContainer(["i-s", "i-t"], {
            id: "ios-app-session-1",
            name: "ios-app-ios",
            repo: "/code/ios",
            branch: "main",
          }),
        ],
      },
    );
    const { run } = await setup({
      built: ownSession,
      expanded: () => ({
        flow: withLibrarySession,
        uses: [{ path: "ios-app", name: "iOS library", kind: "session-library" }],
      }),
    });

    await run.getState().openBuild(fromCard);

    expect(run.getState().buildDialog?.target).toEqual({
      repoOverride: false,
      existingBranch: false,
      branch: true,
      sessions: [
        { name: "main", repo: "/code/shop", branch: "dev" },
        { name: "ios-app-ios", repo: "/code/ios", branch: "main" },
      ],
    });
  });

  describe("whose only session comes from a session library", () => {
    const workspaceHost = (): Flow =>
      flow(
        [trigger("w-start"), output("w-stop"), library("lib-1", "android-app")],
        [thenWire("w-start", "w-stop")],
        flowSettings,
        { containers: [workspaceContainer(["w-start", "w-stop"])] },
      );
    const expandedHost = (): Flow =>
      flow(
        [trigger("w-start"), output("w-stop"), trigger("a-s"), output("a-t")],
        [thenWire("w-start", "w-stop"), thenWire("a-s", "a-t")],
        flowSettings,
        {
          containers: [
            workspaceContainer(["w-start", "w-stop"]),
            sessionContainer(["a-s", "a-t"], {
              id: "android-app-session-1",
              name: "android-app-android",
              repo: "/code/android",
              branch: "mc-branch",
            }),
          ],
        },
      );
    const opened = async () => {
      const ready = await setup({
        built: workspaceHost(),
        expanded: () => ({
          flow: expandedHost(),
          uses: [{ path: "android-app", name: "Android", kind: "session-library" }],
        }),
      });
      await ready.run
        .getState()
        .openBuild({ flowId: "flow-b", version: 4, buildConfig: {}, variables: [] });
      return ready;
    };

    it("prefills the library session's repo and its override branch as the base", async () => {
      const { bridge, run } = await opened();

      expect(bridge.defaultBranch).not.toHaveBeenCalled();
      expect(run.getState().buildDialog).toMatchObject({
        repo: "/code/android",
        base: "mc-branch",
      });
    });

    it("builds from the override branch unless another base is typed", async () => {
      const { bridge, run } = await opened();
      run.getState().editBuild({ name: "fix-login" });
      await run.getState().confirmBuild();

      expect(bridge.buildVersion.mock.calls[0]?.[0]).toMatchObject({
        repo: "/code/android",
        base: "mc-branch",
        branch: { mode: "new", name: "flowdeck/fix-login", base: "mc-branch" },
      });

      await run
        .getState()
        .openBuild({ flowId: "flow-b", version: 4, buildConfig: {}, variables: [] });
      run.getState().editBuild({ name: "fix-login", base: "dev" });
      await run.getState().confirmBuild();

      expect(bridge.buildVersion.mock.calls[1]?.[0]).toMatchObject({
        base: "dev",
        branch: { mode: "new", name: "flowdeck/fix-login", base: "dev" },
      });
    });
  });

  it("refuses to build when the expansion answer cannot be read", async () => {
    const { run } = await setup({ latest: host(), expanded: () => null });

    await run.getState().openBuild();

    expect(run.getState().buildDialog?.problem).toBe("The libraries could not be expanded");
  });

  it("keeps the two uses of one library apart, each with its own field (AT-7)", async () => {
    const { run } = await setup({
      latest: host(),
      expanded: expandedWith(
        ["android-app.isFullScan", "android-app-2.isFullScan"],
        ["android-app", "android-app-2"],
      ),
    });

    await run.getState().openBuild();

    const groups = variableGroups(run.getState().buildDialog?.variables ?? []);
    expect(
      groups.map(({ path, heading, variables }) => ({
        path,
        heading,
        names: variables.map(({ name }) => name),
      })),
    ).toEqual([
      { path: null, heading: null, names: [] },
      {
        path: "android-app",
        heading: "android-app · Android library",
        names: ["android-app.isFullScan"],
      },
      {
        path: "android-app-2",
        heading: "android-app-2 · Android library",
        names: ["android-app-2.isFullScan"],
      },
    ]);
  });
});

describe("variableGroups", () => {
  const own = { name: "ticket", kind: "text" as const, nodeIds: ["plan"] as [string] };
  const used = (name: string, path: string) => ({
    name,
    kind: "yes-no" as const,
    nodeIds: ["n"] as [string],
    group: { path, name: "Android library" },
  });

  it("puts the host's own variables first, then one group per use ordered by its path", () => {
    expect(variableGroups([used("b.x", "b"), own, used("a.y", "a"), used("b.z", "b")])).toEqual([
      { path: null, heading: null, variables: [own] },
      { path: "a", heading: "a · Android library", variables: [used("a.y", "a")] },
      {
        path: "b",
        heading: "b · Android library",
        variables: [used("b.x", "b"), used("b.z", "b")],
      },
    ]);
  });

  it("has only the host's group when no library is used", () => {
    expect(variableGroups([own])).toEqual([{ path: null, heading: null, variables: [own] }]);
  });
});
