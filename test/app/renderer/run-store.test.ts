import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import {
  createRunStore,
  selectNodeDisplay,
  selectLiveBadge,
  selectRunDisabled,
  selectRunSummary,
} from "../../../src/app/renderer/run-store.js";
import { createSaveStore, type SaveBridge } from "../../../src/app/renderer/save-store.js";
import type { NodeState } from "../../../src/core/run/state.js";
import { flow, prompt } from "../../fixtures/flow-builders.js";

type RunBridge = Pick<FlowdeckBridge, "buildVersion" | "runBuild" | "getRunState" | "onRunState">;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const snapshot = (
  status: "running" | "done" | "failed" | "stopped",
  nodes: Record<string, NodeState> = { "prompt-1": "waiting" },
) => ({ runId: "run-1", status, nodes });

const savedFlow = () => flow([prompt("prompt-1")], []);

const setup = async (options: { latest?: unknown } = {}) => {
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
    buildVersion: vi.fn<(ref: { flowId: string; version: number }) => Promise<unknown>>(
      async () => {
        calls.push("buildVersion");
        return { kind: "built", hash: "h1", dir: "/fd/builds/h1", reused: false, restored: [] };
      },
    ),
    runBuild: vi.fn<(payload: { hash: string }) => Promise<unknown>>(async () => {
      calls.push("runBuild");
      return { kind: "started", runId: "run-1" };
    }),
    getRunState: vi.fn<() => Promise<unknown>>(async () => {
      calls.push("getRunState");
      return null;
    }),
    onRunState: vi.fn((listener: (value: unknown) => void) => {
      calls.push("onRunState");
      pushListener = listener;
      return () => {};
    }),
  } satisfies RunBridge;

  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge: saveBridge, canvas });
  await save.getState().open();
  const run = createRunStore({ bridge, save, canvas });
  const push = (value: unknown) => pushListener(value);
  const disabled = () => selectRunDisabled(run.getState(), save.getState());

  return { bridge, saveBridge, canvas, save, run, calls, push, disabled };
};

const makeDirty = (canvas: ReturnType<typeof createCanvasStore>) =>
  canvas.getState().drop("script", { x: 200, y: 0 });

describe("connect", () => {
  it("subscribes to run-state pushes before asking for the current run state", async () => {
    const { run, calls } = await setup();

    await run.getState().connect();

    expect(calls).toEqual(["onRunState", "getRunState"]);
  });

  it("shows the snapshot getRunState returns when no push came first", async () => {
    const { bridge, run } = await setup();
    bridge.getRunState.mockResolvedValueOnce(snapshot("running"));

    await run.getState().connect();

    expect(run.getState().snapshot).toEqual(snapshot("running"));
  });

  it("replaces the snapshot with each pushed one", async () => {
    const { bridge, run, push } = await setup();
    bridge.getRunState.mockResolvedValueOnce(snapshot("running"));
    await run.getState().connect();

    push(snapshot("done", { "prompt-1": "done" }));

    expect(run.getState().snapshot).toEqual(snapshot("done", { "prompt-1": "done" }));
  });

  it("keeps a push that arrived before getRunState answered", async () => {
    const { bridge, run, push } = await setup();
    const answer = deferred<unknown>();
    bridge.getRunState.mockReturnValueOnce(answer.promise);

    const connecting = run.getState().connect();
    push(snapshot("done", { "prompt-1": "done" }));
    answer.resolve(snapshot("running"));
    await connecting;

    expect(run.getState().snapshot).toEqual(snapshot("done", { "prompt-1": "done" }));
  });

  it("ignores payloads that are not run snapshots", async () => {
    const { bridge, run, push } = await setup();
    bridge.getRunState.mockResolvedValueOnce({ runId: "run-1", status: "sideways", nodes: {} });
    await run.getState().connect();

    expect(run.getState().snapshot).toBeNull();

    push(snapshot("running"));
    push({ nodes: "none" });
    push("done");

    expect(run.getState().snapshot).toEqual(snapshot("running"));
  });
});

describe("run (Build & run)", () => {
  it("builds the saved version and runs that build, without saving a clean canvas", async () => {
    const { bridge, saveBridge, run, calls } = await setup({ latest: savedFlow() });

    await expect(run.getState().run()).resolves.toBe("run-1");

    expect(saveBridge.saveFlow).not.toHaveBeenCalled();
    expect(bridge.buildVersion).toHaveBeenCalledWith({ flowId: "flow-1", version: 1 });
    expect(bridge.runBuild).toHaveBeenCalledWith({ hash: "h1" });
    expect(calls).toEqual(["buildVersion", "runBuild"]);
    expect(run.getState().lastBuild).toEqual({ hash: "h1", flowId: "flow-1", version: 1 });
  });

  it("saves a dirty canvas first and builds the version that save made", async () => {
    const { bridge, saveBridge, canvas, run, calls } = await setup({ latest: savedFlow() });
    makeDirty(canvas);
    const edited = canvas.getState().flow;

    await run.getState().run();

    expect(saveBridge.saveFlow).toHaveBeenCalledWith({
      flowId: "flow-1",
      name: "Untitled",
      flow: edited,
    });
    expect(bridge.buildVersion).toHaveBeenCalledWith({ flowId: "flow-1", version: 2 });
    expect(calls).toEqual(["saveFlow", "buildVersion", "runBuild"]);
  });

  it("force-saves a clean canvas that has never been saved, then builds and runs it", async () => {
    const { saveBridge, canvas, run, calls } = await setup({ latest: null });
    const fresh = canvas.getState().flow;

    await run.getState().run();

    expect(saveBridge.saveFlow).toHaveBeenCalledWith({
      flowId: null,
      name: "Untitled",
      flow: fresh,
    });
    expect(calls).toEqual(["saveFlow", "buildVersion", "runBuild"]);
  });

  it("neither builds nor runs when the save fails, and holds the save error", async () => {
    const { bridge, saveBridge, canvas, run } = await setup({ latest: savedFlow() });
    makeDirty(canvas);
    saveBridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });

    await expect(run.getState().run()).resolves.toBeNull();

    expect(bridge.buildVersion).not.toHaveBeenCalled();
    expect(bridge.runBuild).not.toHaveBeenCalled();
    expect(run.getState().error).toBe("disk full");
  });

  it("does not run when the build fails, and holds the build's problems", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.buildVersion.mockResolvedValueOnce({ kind: "error", message: "ports: p1 has no input" });

    await run.getState().run();

    expect(bridge.runBuild).not.toHaveBeenCalled();
    expect(run.getState().error).toBe("ports: p1 has no input");
  });

  it("holds the message of an error result from runBuild", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.runBuild.mockResolvedValueOnce({
      kind: "error",
      message: "A run is already in progress",
    });

    await expect(run.getState().run()).resolves.toBeNull();

    expect(run.getState().error).toBe("A run is already in progress");
  });

  it("holds an error when runBuild answers with something that is not a start result", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.runBuild.mockResolvedValueOnce({ kind: "begun" });

    await run.getState().run();

    expect(run.getState().error).toEqual(expect.any(String));
    expect(run.getState().error).not.toBe("");
  });

  it("clears the error once a run starts", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.runBuild.mockResolvedValueOnce({ kind: "error", message: "boom" });
    await run.getState().run();
    expect(run.getState().error).toBe("boom");

    await run.getState().run();

    expect(run.getState().error).toBeNull();
  });
});

describe("build", () => {
  it("saves if needed, builds the saved version and keeps it as the last build, without running", async () => {
    const { bridge, canvas, run, calls } = await setup({ latest: savedFlow() });
    makeDirty(canvas);

    await expect(run.getState().build()).resolves.toBe("h1");

    expect(calls).toEqual(["saveFlow", "buildVersion"]);
    expect(bridge.runBuild).not.toHaveBeenCalled();
    expect(run.getState()).toMatchObject({
      starting: false,
      error: null,
      lastBuild: { hash: "h1", flowId: "flow-1", version: 2 },
    });
  });

  it("holds the build's problems and no last build when it fails", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.buildVersion.mockResolvedValueOnce({ kind: "error", message: "no-cycle: loop" });

    await expect(run.getState().build()).resolves.toBeNull();

    expect(run.getState()).toMatchObject({ error: "no-cycle: loop", lastBuild: null });
  });
});

describe("buildVersion", () => {
  it("builds a given saved version without saving the editor", async () => {
    const { bridge, canvas, run, calls } = await setup({ latest: savedFlow() });
    makeDirty(canvas);

    await expect(run.getState().buildVersion({ flowId: "flow-b", version: 4 })).resolves.toBe("h1");

    expect(bridge.buildVersion).toHaveBeenCalledWith({ flowId: "flow-b", version: 4 });
    expect(calls).toEqual(["buildVersion"]);
    expect(run.getState().lastBuild).toEqual({ hash: "h1", flowId: "flow-b", version: 4 });
  });
});

describe("runBuild", () => {
  it("runs the given build without saving or building", async () => {
    const { bridge, canvas, run, calls } = await setup({ latest: savedFlow() });
    makeDirty(canvas);

    await expect(run.getState().runBuild("abc")).resolves.toBe("run-1");

    expect(bridge.runBuild).toHaveBeenCalledWith({ hash: "abc" });
    expect(calls).toEqual(["runBuild"]);
  });

  it("does nothing while a run is running", async () => {
    const { bridge, run, push } = await setup({ latest: savedFlow() });
    await run.getState().connect();
    push(snapshot("running"));

    await expect(run.getState().runBuild("abc")).resolves.toBeNull();

    expect(bridge.runBuild).not.toHaveBeenCalled();
  });
});

describe("selectRunDisabled", () => {
  it("is false when nothing is starting, saving or running", async () => {
    const { disabled } = await setup({ latest: savedFlow() });

    expect(disabled()).toBe(false);
  });

  it("is true while a run is starting, and run does nothing then", async () => {
    const { bridge, run, disabled } = await setup({ latest: savedFlow() });
    const answer = deferred<unknown>();
    bridge.runBuild.mockReturnValueOnce(answer.promise);

    const first = run.getState().run();
    await vi.waitFor(() => expect(bridge.runBuild).toHaveBeenCalledTimes(1));

    expect(run.getState().starting).toBe(true);
    expect(disabled()).toBe(true);
    await run.getState().run();
    expect(bridge.runBuild).toHaveBeenCalledTimes(1);

    answer.resolve({ kind: "started", runId: "run-1" });
    await first;
    expect(run.getState().starting).toBe(false);
  });

  it("is true while the save store is saving, and run does nothing then", async () => {
    const { bridge, saveBridge, canvas, save, run, disabled } = await setup({
      latest: savedFlow(),
    });
    makeDirty(canvas);
    const reply = deferred<unknown>();
    saveBridge.saveFlow.mockReturnValueOnce(reply.promise);
    const saving = save.getState().save();

    expect(disabled()).toBe(true);
    await run.getState().run();

    expect(bridge.buildVersion).not.toHaveBeenCalled();
    expect(saveBridge.saveFlow).toHaveBeenCalledTimes(1);
    reply.resolve({ kind: "saved", flowId: "flow-1", version: 2 });
    await saving;
  });

  it("is true while the snapshot is running, and run does nothing then", async () => {
    const { bridge, run, push, disabled } = await setup({ latest: savedFlow() });
    await run.getState().connect();
    push(snapshot("running"));

    expect(disabled()).toBe(true);
    await run.getState().run();
    expect(bridge.buildVersion).not.toHaveBeenCalled();

    push(snapshot("done", { "prompt-1": "done" }));
    expect(disabled()).toBe(false);
  });
});

describe("selectNodeDisplay", () => {
  it("is null before any snapshot", async () => {
    const { run } = await setup();

    expect(selectNodeDisplay(run.getState(), "prompt-1")).toBeNull();
  });

  it("maps each node's state to its display status, and is null for ids not in the snapshot", async () => {
    const { run, push } = await setup();
    await run.getState().connect();

    push(snapshot("running", { a: "sent", b: "needs-you", c: "skipped" }));

    expect(selectNodeDisplay(run.getState(), "a")).toBe("running");
    expect(selectNodeDisplay(run.getState(), "b")).toBe("needs you");
    expect(selectNodeDisplay(run.getState(), "c")).toBe("skipped");
    expect(selectNodeDisplay(run.getState(), "zz")).toBeNull();
  });
});

describe("selectRunSummary", () => {
  const summaryOf = async (value: unknown) => {
    const { run, push } = await setup();
    await run.getState().connect();
    push(value);
    return selectRunSummary(run.getState());
  };

  it("is Idle before any snapshot", async () => {
    const { run } = await setup();

    expect(selectRunSummary(run.getState())).toBe("Idle");
  });

  it("counts done nodes while running", async () => {
    expect(
      await summaryOf(
        snapshot("running", { a: "done", b: "done", c: "done", d: "running", e: "waiting" }),
      ),
    ).toBe("Running · 3 of 5 nodes done");
  });

  it("says Needs you when a node waits on the user", async () => {
    expect(await summaryOf(snapshot("running", { a: "done", b: "needs-you" }))).toBe(
      "Needs you · 1 of 2 nodes done",
    );
  });

  it("says Failed when a node failed", async () => {
    expect(await summaryOf(snapshot("failed", { a: "done", b: "failed" }))).toBe(
      "Failed · 1 of 2 nodes done",
    );
  });

  it("puts Needs you before Failed", async () => {
    expect(await summaryOf(snapshot("running", { a: "failed", b: "needs-you" }))).toBe(
      "Needs you · 0 of 2 nodes done",
    );
  });

  it("says Done once every node is done and the run stopped running", async () => {
    expect(
      await summaryOf(snapshot("done", { a: "done", b: "done", c: "done", d: "done", e: "done" })),
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
