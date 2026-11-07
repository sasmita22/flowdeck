import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import { noBlueprint } from "../../../src/app/renderer/library-store.js";
import {
  createRunStore,
  needsSessionSetup,
  selectCanBuild,
  selectKeptNote,
  selectLiveBadge,
  selectNodeDisplay,
  selectRunDisabled,
  selectRunHint,
  selectRunningCount,
  selectRunSnapshot,
  selectRunSummary,
} from "../../../src/app/renderer/run-store.js";
import { createSaveStore, type SaveBridge } from "../../../src/app/renderer/save-store.js";
import type { BuildConfig, Flow } from "../../../src/core/flow/schema.js";
import type { NodeState } from "../../../src/core/run/state.js";
import { flow, prompt } from "../../fixtures/flow-builders.js";

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
  | "deleteBuild"
  | "defaultBranch"
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
  nodes: Record<string, NodeState> = { "prompt-1": "waiting" },
  runId = "run-1",
) => ({ runId, status, nodes });

const configured = (buildConfig: BuildConfig): Flow => {
  const base = flow([prompt("prompt-1")], []);
  return { ...base, session: { ...base.session, buildConfig } };
};

const declared: BuildConfig = {
  repo: "/code/shop",
  variables: [
    { name: "ticket", kind: "text" },
    { name: "deep", kind: "yesno", default: true },
  ],
};

const built = { kind: "built", id: "b-0f3a9c2e", hash: "h1", dir: "/fd/workspaces/b-0f3a9c2e" };

const setup = async (
  options: {
    latest?: Flow | null;
    automatic?: boolean;
    defaultBranch?: string;
    runState?: Promise<unknown>;
  } = {},
) => {
  const calls: string[] = [];
  let pushListener: (value: unknown) => void = () => undefined;

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
    deleteBuild: vi.fn<FlowdeckBridge["deleteBuild"]>(async () => ({ ok: true })),
    defaultBranch: vi.fn<FlowdeckBridge["defaultBranch"]>(async () => {
      calls.push("defaultBranch");
      return options.defaultBranch ?? "main";
    }),
  } satisfies RunBridge;

  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge: saveBridge, canvas });
  await save.getState().open();
  const run = createRunStore({ bridge, save, canvas });
  const push = (value: unknown) => pushListener(value);

  return { bridge, saveBridge, canvas, save, run, calls, push };
};

const makeDirty = (canvas: ReturnType<typeof createCanvasStore>) =>
  canvas.getState().drop("script", { x: 200, y: 0 });

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
      latest: configured({ ...declared, base: "dev" }),
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
      variables: declared.variables,
      values: { deep: true },
      buildModel: "",
      error: null,
    });
  });

  it("saves a dirty canvas first and opens on the version that save made", async () => {
    const { canvas, run, calls } = await setup({ latest: configured(declared) });
    makeDirty(canvas);

    await run.getState().openBuild();

    expect(calls).toEqual(["saveFlow", "defaultBranch"]);
    expect(run.getState().buildDialog).toMatchObject({ flowId: "flow-1", version: 2 });
  });

  it("opens nothing and holds the save error when the save fails", async () => {
    const { saveBridge, canvas, run } = await setup({ latest: configured(declared) });
    makeDirty(canvas);
    saveBridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });

    await run.getState().openBuild();

    expect(run.getState().buildDialog).toBeNull();
    expect(run.getState().error).toBe("disk full");
  });

  it("opens for a blueprint's latest version, starting from the repo's default branch when it names no base", async () => {
    const { bridge, canvas, run, calls } = await setup({ defaultBranch: "trunk" });
    makeDirty(canvas);

    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });

    expect(calls).toEqual(["defaultBranch"]);
    expect(bridge.defaultBranch).toHaveBeenCalledWith({ repo: "/code/shop" });
    expect(run.getState().buildDialog).toMatchObject({
      flowId: "flow-b",
      version: 4,
      repo: "/code/shop",
      base: "trunk",
      values: { deep: true },
    });
  });

  it("leaves the base empty when the blueprint names no repo", async () => {
    const { bridge, run } = await setup();

    await run
      .getState()
      .openBuild({ flowId: "flow-b", version: 4, buildConfig: { variables: [] } });

    expect(bridge.defaultBranch).not.toHaveBeenCalled();
    expect(run.getState().buildDialog).toMatchObject({ repo: "", base: "" });
  });

  it("cannot build until the name, repo, base and every value are set", async () => {
    const { run } = await setup();
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });
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

  it("builds with the name, repo, base and values, closes, and keeps the build as the last one", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");

    await expect(run.getState().confirmBuild()).resolves.toBe("b-0f3a9c2e");

    expect(bridge.buildVersion).toHaveBeenCalledWith({
      flowId: "flow-b",
      version: 4,
      name: "fix-login",
      repo: "/code/shop",
      base: "main",
      values: { ticket: "FD-1", deep: true },
    });
    expect(run.getState()).toMatchObject({
      buildDialog: null,
      error: null,
      lastBuild: { id: "b-0f3a9c2e", name: "fix-login", flowId: "flow-b", version: 4 },
    });
  });

  it("builds with the build model given in the dialog", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });
    run.getState().editBuild({ name: "fix-login", buildModel: "haiku" });
    run.getState().setValue("ticket", "FD-1");

    await run.getState().confirmBuild();

    expect(bridge.buildVersion).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fix-login", buildModel: "haiku" }),
    );
  });

  it("starts the build model field from the blueprint's build configuration", async () => {
    const { run } = await setup();

    await run.getState().openBuild({
      flowId: "flow-b",
      version: 4,
      buildConfig: { ...declared, buildModel: "sonnet" },
    });

    expect(run.getState().buildDialog?.buildModel).toBe("sonnet");
  });

  it("does not build while it cannot", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });

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
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");
    bridge.buildVersion.mockResolvedValueOnce({ kind: "error", message });

    await expect(run.getState().confirmBuild()).resolves.toBeNull();

    expect(run.getState().buildDialog).toMatchObject({ name: "fix-login", error: message });
    expect(run.getState().lastBuild).toBeNull();
  });

  it("clears the refusal once the name is edited", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");
    bridge.buildVersion.mockResolvedValueOnce({ kind: "error", message: "taken" });
    await run.getState().confirmBuild();

    run.getState().editBuild({ name: "fix-login-2" });

    expect(run.getState().buildDialog?.error).toBeNull();
  });

  it("closes with no error on a started build and answers its pending id", async () => {
    const { bridge, run } = await setup();
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });
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
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });
    run.getState().editBuild({ name: "fix-login" });
    run.getState().setValue("ticket", "FD-1");
    const problems = [{ node: "prompt-1", field: "text", text: "Write the prompt." }];
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
    await run.getState().openBuild({ flowId: "flow-b", version: 4, buildConfig: declared });

    run.getState().cancelBuild();

    expect(run.getState().buildDialog).toBeNull();
    expect(bridge.buildVersion).not.toHaveBeenCalled();
  });
});

describe("needsSessionSetup", () => {
  it("is true when a problem is about the session's Build configuration", () => {
    expect(needsSessionSetup([{ field: "buildConfig.repo", text: "Choose the repository." }])).toBe(
      true,
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
    expect(selectRunHint({ old: true, blueprint: noBlueprint })).toBe(
      "Builds from before named builds can't run again.",
    );
    expect(selectRunHint({ old: false, blueprint: noBlueprint })).toBeNull();
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
    bridge.deleteBuild.mockResolvedValueOnce({ ok: true, kept });

    await run.getState().deleteBuild("b-1");

    expect(run.getState().kept).toEqual({ buildId: "b-1", ...kept });
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
      { kind: "folder", path: "/elsewhere/builds/oldhash" },
      "The build is deleted. Its folder /elsewhere/builds/oldhash is outside FLOWDECK_HOME, so it was left in place.",
    ],
  ] as const)("words what it kept, %j, by why it was kept", (kept, note) => {
    expect(selectKeptNote({ buildId: "b-1", ...kept })).toBe(note);
  });

  it("holds the refusal and keeps nothing when the build cannot be deleted", async () => {
    const { bridge, run } = await setup();
    bridge.deleteBuild.mockResolvedValueOnce({ ok: false, message: "A run of b-1 is going" });

    await expect(run.getState().deleteBuild("b-1")).resolves.toBe(false);

    expect(run.getState()).toMatchObject({ kept: null, error: "A run of b-1 is going" });
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
});

describe("selectNodeDisplay", () => {
  it("is null before any snapshot", () => {
    expect(selectNodeDisplay({ snapshot: null }, "prompt-1")).toBeNull();
  });

  it("maps each node's state to its display status, and is null for ids not in the snapshot", () => {
    const view = { snapshot: snapshot("running", { a: "sent", b: "needs-you", c: "skipped" }) };

    expect(selectNodeDisplay(view, "a")).toBe("sent");
    expect(selectNodeDisplay(view, "b")).toBe("needs you");
    expect(selectNodeDisplay(view, "c")).toBe("skipped");
    expect(selectNodeDisplay(view, "zz")).toBeNull();
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

  it("says Done once every node is done and the run stopped running", () => {
    expect(
      summaryOf(snapshot("done", { a: "done", b: "done", c: "done", d: "done", e: "done" })),
    ).toBe("Done · 5 of 5 nodes done");
  });
});

describe("selectLiveBadge", () => {
  it("counts done nodes while running, says needs you first, and is null once finished", () => {
    expect(selectLiveBadge(snapshot("running", { a: "done", b: "running", c: "waiting" }))).toBe(
      "running · 1 of 3",
    );
    expect(selectLiveBadge(snapshot("running", { a: "done", b: "needs-you" }))).toBe("needs you");
    expect(selectLiveBadge(snapshot("done", { a: "done" }))).toBeNull();
    expect(selectLiveBadge(null)).toBeNull();
  });
});
