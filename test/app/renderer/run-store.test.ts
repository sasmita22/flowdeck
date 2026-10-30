import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import {
  createRunStore,
  selectNodeDisplay,
  selectRunDisabled,
} from "../../../src/app/renderer/run-store.js";
import { createSaveStore, type SaveBridge } from "../../../src/app/renderer/save-store.js";
import { flow, prompt } from "../../fixtures/flow-builders.js";

type RunBridge = Pick<FlowdeckBridge, "startRun" | "getRunState" | "onRunState">;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const snapshot = (
  status: "running" | "done" | "failed" | "stopped",
  nodes: Record<string, string> = { "prompt-1": "waiting" },
) => ({ runId: "run-1", status, nodes });

const savedFlow = () => flow([prompt("prompt-1")], []);

const setup = async (options: { latest?: unknown } = {}) => {
  const calls: string[] = [];
  let pushListener: (value: unknown) => void = () => undefined;

  const saveBridge = {
    saveFlow: vi.fn<(flow: unknown) => Promise<unknown>>(async () => {
      calls.push("saveFlow");
      return { kind: "saved", flowId: "flow-1", version: 1 };
    }),
    loadLatestFlow: vi.fn<() => Promise<unknown>>(async () => options.latest ?? null),
    setDirty: vi.fn<(dirty: boolean) => void>(),
    onCloseRequest: vi.fn(() => () => {}),
    answerClose: vi.fn<(answer: "close" | "cancel") => void>(),
  } satisfies SaveBridge;

  const bridge = {
    startRun: vi.fn<() => Promise<unknown>>(async () => {
      calls.push("startRun");
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

describe("run", () => {
  it("starts the run without saving when the canvas is clean and has a saved version", async () => {
    const { bridge, saveBridge, run } = await setup({ latest: savedFlow() });

    await run.getState().run();

    expect(saveBridge.saveFlow).not.toHaveBeenCalled();
    expect(bridge.startRun).toHaveBeenCalledTimes(1);
  });

  it("saves a dirty canvas first and sends the flow before starting the run", async () => {
    const { bridge, saveBridge, canvas, run, calls } = await setup({ latest: savedFlow() });
    makeDirty(canvas);
    const edited = canvas.getState().flow;

    await run.getState().run();

    expect(saveBridge.saveFlow).toHaveBeenCalledWith(edited);
    expect(calls.filter((call) => call !== "getRunState")).toEqual(["saveFlow", "startRun"]);
    expect(bridge.startRun).toHaveBeenCalledTimes(1);
  });

  it("force-saves a clean canvas that has never been saved, then starts the run", async () => {
    const { saveBridge, canvas, run, calls } = await setup({ latest: null });
    const fresh = canvas.getState().flow;

    await run.getState().run();

    expect(saveBridge.saveFlow).toHaveBeenCalledWith(fresh);
    expect(calls).toEqual(["saveFlow", "startRun"]);
  });

  it("does not start the run when the save fails, and holds the save error", async () => {
    const { bridge, saveBridge, canvas, run } = await setup({ latest: savedFlow() });
    makeDirty(canvas);
    saveBridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });

    await run.getState().run();

    expect(bridge.startRun).not.toHaveBeenCalled();
    expect(run.getState().error).toBe("disk full");
  });

  it("holds the message of an error result from startRun", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.startRun.mockResolvedValueOnce({
      kind: "error",
      message: "Save the flow before running it",
    });

    await run.getState().run();

    expect(run.getState().error).toBe("Save the flow before running it");
  });

  it("holds an error when startRun answers with something that is not a start result", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.startRun.mockResolvedValueOnce({ kind: "begun" });

    await run.getState().run();

    expect(run.getState().error).toEqual(expect.any(String));
    expect(run.getState().error).not.toBe("");
  });

  it("clears the error once a run starts", async () => {
    const { bridge, run } = await setup({ latest: savedFlow() });
    bridge.startRun.mockResolvedValueOnce({ kind: "error", message: "boom" });
    await run.getState().run();
    expect(run.getState().error).toBe("boom");

    await run.getState().run();

    expect(run.getState().error).toBeNull();
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
    bridge.startRun.mockReturnValueOnce(answer.promise);

    const first = run.getState().run();
    await vi.waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1));

    expect(run.getState().starting).toBe(true);
    expect(disabled()).toBe(true);
    await run.getState().run();
    expect(bridge.startRun).toHaveBeenCalledTimes(1);

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

    expect(bridge.startRun).not.toHaveBeenCalled();
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
    expect(bridge.startRun).not.toHaveBeenCalled();

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
    expect(selectNodeDisplay(run.getState(), "c")).toBe("done");
    expect(selectNodeDisplay(run.getState(), "zz")).toBeNull();
  });
});
