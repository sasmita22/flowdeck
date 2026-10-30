import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import {
  createCanvasStore,
  newCanvasFlow,
  selectDirty,
} from "../../../src/app/renderer/canvas/store.js";
import { createSaveStore } from "../../../src/app/renderer/save-store.js";
import { flow, prompt } from "../../fixtures/flow-builders.js";

type SaveBridge = Pick<
  FlowdeckBridge,
  "saveFlow" | "loadLatestFlow" | "setDirty" | "onCloseRequest" | "answerClose"
>;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const fakeBridge = (options: { latest?: () => Promise<unknown> } = {}) => {
  const closeListeners: (() => void)[] = [];
  const bridge = {
    saveFlow: vi.fn<(flow: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ kind: "saved", flowId: "flow-1", version: 1 }),
    ),
    loadLatestFlow: vi.fn<() => Promise<unknown>>(options.latest ?? (() => Promise.resolve(null))),
    setDirty: vi.fn<(dirty: boolean) => void>(),
    onCloseRequest: vi.fn((listener: () => void) => {
      closeListeners.push(listener);
      return () => {};
    }),
    answerClose: vi.fn<(answer: "close" | "cancel") => void>(),
  } satisfies SaveBridge;
  const requestClose = () => {
    for (const listener of closeListeners) listener();
  };
  return { bridge, requestClose };
};

const savedFlow = () => flow([prompt("prompt-1")], []);

const setup = async (options: { latest?: () => Promise<unknown> } = {}) => {
  const { bridge, requestClose } = fakeBridge(options);
  const canvas = createCanvasStore({ ready: false });
  const store = createSaveStore({ bridge, canvas });
  await store.getState().open();
  return { bridge, requestClose, canvas, store };
};

const makeDirty = (canvas: ReturnType<typeof createCanvasStore>) =>
  canvas.getState().drop("script", { x: 200, y: 0 });

describe("createSaveStore", () => {
  it("starts not saving, with no error and no close prompt", () => {
    const { bridge } = fakeBridge();
    const store = createSaveStore({ bridge, canvas: createCanvasStore({ ready: false }) });

    expect(store.getState()).toMatchObject({ saving: false, error: null, closePrompt: false });
  });
});

describe("open", () => {
  it("loads an empty canvas, ready and clean, when nothing has been saved", async () => {
    const { canvas } = await setup({ latest: () => Promise.resolve(null) });

    expect(canvas.getState().ready).toBe(true);
    expect(canvas.getState().flow).toEqual(newCanvasFlow());
    expect(selectDirty(canvas.getState())).toBe(false);
  });

  it("loads the saved flow into the canvas, clean", async () => {
    const { canvas, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });

    expect(canvas.getState().ready).toBe(true);
    expect(canvas.getState().flow).toEqual(savedFlow());
    expect(selectDirty(canvas.getState())).toBe(false);
    expect(store.getState().error).toBeNull();
  });

  it("holds the error and keeps the canvas not ready when the load rejects", async () => {
    const { canvas, store } = await setup({
      latest: () => Promise.reject(new Error("engine exited")),
    });

    expect(store.getState().error).toBe("engine exited");
    expect(canvas.getState().ready).toBe(false);
  });

  it("holds an error and keeps the canvas not ready when the loaded value is not a flow", async () => {
    const { canvas, store } = await setup({ latest: () => Promise.resolve({ nodes: "none" }) });

    expect(store.getState().error).toEqual(expect.any(String));
    expect(store.getState().error).not.toBe("");
    expect(canvas.getState().ready).toBe(false);
  });
});

describe("dirty reporting", () => {
  it("reports the initial dirty value once at creation", () => {
    const { bridge } = fakeBridge();

    createSaveStore({ bridge, canvas: createCanvasStore({ ready: false }) });

    expect(bridge.setDirty.mock.calls).toEqual([[false]]);
  });

  it("reports dirty once on the first edit and clean after undo back", async () => {
    const { bridge, canvas } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    bridge.setDirty.mockClear();

    makeDirty(canvas);
    canvas.getState().drop("prompt", { x: 0, y: 300 });

    expect(bridge.setDirty.mock.calls).toEqual([[true]]);

    canvas.getState().undo();
    canvas.getState().undo();

    expect(bridge.setDirty.mock.calls).toEqual([[true], [false]]);
  });

  it("reports nothing for a selection change", async () => {
    const { bridge, canvas } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    bridge.setDirty.mockClear();

    canvas.getState().select(["prompt-1"]);

    expect(bridge.setDirty).not.toHaveBeenCalled();
  });
});

describe("save", () => {
  it("does nothing when the canvas is clean", async () => {
    const { bridge, store } = await setup();

    await store.getState().save();

    expect(bridge.saveFlow).not.toHaveBeenCalled();
    expect(store.getState().saving).toBe(false);
  });

  it("sends the current flow, is saving during the call, then marks it saved", async () => {
    const { bridge, canvas, store } = await setup();
    makeDirty(canvas);
    const sent = canvas.getState().flow;
    const reply = deferred<unknown>();
    bridge.saveFlow.mockReturnValueOnce(reply.promise);

    const saving = store.getState().save();

    expect(bridge.saveFlow).toHaveBeenCalledTimes(1);
    expect(bridge.saveFlow).toHaveBeenCalledWith(sent);
    expect(store.getState().saving).toBe(true);

    reply.resolve({ kind: "saved", flowId: "flow-1", version: 1 });

    await expect(saving).resolves.toBe(true);
    expect(store.getState().saving).toBe(false);
    expect(canvas.getState().saved).toEqual(sent);
    expect(selectDirty(canvas.getState())).toBe(false);
  });

  it("marks the sent snapshot saved, so an edit made during the save stays dirty", async () => {
    const { bridge, canvas, store } = await setup();
    makeDirty(canvas);
    const sent = canvas.getState().flow;
    const reply = deferred<unknown>();
    bridge.saveFlow.mockReturnValueOnce(reply.promise);

    const saving = store.getState().save();
    canvas.getState().drop("prompt", { x: 0, y: 300 });
    reply.resolve({ kind: "saved", flowId: "flow-1", version: 1 });

    await expect(saving).resolves.toBe(true);
    expect(canvas.getState().saved).toEqual(sent);
    expect(selectDirty(canvas.getState())).toBe(true);
  });

  it("holds the error, stays dirty and resolves false on an error result", async () => {
    const { bridge, canvas, store } = await setup();
    makeDirty(canvas);
    bridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });

    await expect(store.getState().save()).resolves.toBe(false);

    expect(store.getState().error).toBe("disk full");
    expect(store.getState().saving).toBe(false);
    expect(selectDirty(canvas.getState())).toBe(true);
  });

  it("holds the message, stays dirty and resolves false when saveFlow rejects", async () => {
    const { bridge, canvas, store } = await setup();
    makeDirty(canvas);
    bridge.saveFlow.mockRejectedValueOnce(new Error("engine exited"));

    await expect(store.getState().save()).resolves.toBe(false);

    expect(store.getState().error).toBe("engine exited");
    expect(store.getState().saving).toBe(false);
    expect(selectDirty(canvas.getState())).toBe(true);
  });

  it.each([
    ["an unknown kind", { kind: "done" }],
    ["a saved result without a version", { kind: "saved", flowId: "flow-1" }],
    ["null", null],
    ["a string", "saved"],
  ])("holds an error, stays dirty and resolves false on %s", async (_name, result) => {
    const { bridge, canvas, store } = await setup();
    makeDirty(canvas);
    bridge.saveFlow.mockResolvedValueOnce(result);

    await expect(store.getState().save()).resolves.toBe(false);

    expect(store.getState().error).toEqual(expect.any(String));
    expect(store.getState().error).not.toBe("");
    expect(selectDirty(canvas.getState())).toBe(true);
  });

  it("clears the error of a failed save once a later save succeeds", async () => {
    const { bridge, canvas, store } = await setup();
    makeDirty(canvas);
    bridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });
    await store.getState().save();
    expect(store.getState().error).toBe("disk full");

    await expect(store.getState().save()).resolves.toBe(true);

    expect(store.getState().error).toBeNull();
  });

  it("ignores a second save while one is in flight", async () => {
    const { bridge, canvas, store } = await setup();
    makeDirty(canvas);
    const reply = deferred<unknown>();
    bridge.saveFlow.mockReturnValueOnce(reply.promise);

    const first = store.getState().save();
    void store.getState().save();
    reply.resolve({ kind: "saved", flowId: "flow-1", version: 1 });
    await first;

    expect(bridge.saveFlow).toHaveBeenCalledTimes(1);
  });
});

describe("hasSavedVersion", () => {
  it("is false after open finds nothing saved", async () => {
    const { store } = await setup({ latest: () => Promise.resolve(null) });

    expect(store.getState().hasSavedVersion).toBe(false);
  });

  it("is true after open loads a saved flow", async () => {
    const { store } = await setup({ latest: () => Promise.resolve(savedFlow()) });

    expect(store.getState().hasSavedVersion).toBe(true);
  });

  it("becomes true after a successful save", async () => {
    const { canvas, store } = await setup({ latest: () => Promise.resolve(null) });
    makeDirty(canvas);

    await expect(store.getState().save()).resolves.toBe(true);

    expect(store.getState().hasSavedVersion).toBe(true);
  });
});

describe("forced save", () => {
  it("sends a clean canvas that has no saved version, marks it saved and resolves true", async () => {
    const { bridge, canvas, store } = await setup({ latest: () => Promise.resolve(null) });
    const sent = canvas.getState().flow;

    await expect(store.getState().save({ force: true })).resolves.toBe(true);

    expect(bridge.saveFlow).toHaveBeenCalledTimes(1);
    expect(bridge.saveFlow).toHaveBeenCalledWith(sent);
    expect(canvas.getState().saved).toEqual(sent);
    expect(store.getState().hasSavedVersion).toBe(true);
    expect(store.getState().error).toBeNull();
  });

  it("resolves false, holds the error and leaves hasSavedVersion false when it fails", async () => {
    const { bridge, store } = await setup({ latest: () => Promise.resolve(null) });
    bridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });

    await expect(store.getState().save({ force: true })).resolves.toBe(false);

    expect(store.getState().error).toBe("disk full");
    expect(store.getState().hasSavedVersion).toBe(false);
  });

  it("leaves a plain save of a clean canvas sending nothing", async () => {
    const { bridge, store } = await setup({ latest: () => Promise.resolve(null) });

    await expect(store.getState().save()).resolves.toBe(true);

    expect(bridge.saveFlow).not.toHaveBeenCalled();
    expect(store.getState().hasSavedVersion).toBe(false);
  });

  it("resolves false without an error for a save made while one is in flight", async () => {
    const { bridge, store } = await setup({ latest: () => Promise.resolve(null) });
    const reply = deferred<unknown>();
    bridge.saveFlow.mockReturnValueOnce(reply.promise);

    const first = store.getState().save({ force: true });
    const second = store.getState().save({ force: true });
    reply.resolve({ kind: "saved", flowId: "flow-1", version: 1 });

    await expect(second).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    expect(bridge.saveFlow).toHaveBeenCalledTimes(1);
    expect(store.getState().error).toBeNull();
  });
});

describe("close request", () => {
  it("shows the close prompt when main asks to close", async () => {
    const { requestClose, store } = await setup();

    requestClose();

    expect(store.getState().closePrompt).toBe(true);
  });
});

describe("answerClose", () => {
  const prompted = async () => {
    const ctx = await setup({ latest: () => Promise.resolve(savedFlow()) });
    makeDirty(ctx.canvas);
    ctx.requestClose();
    return ctx;
  };

  it("cancel hides the prompt, answers cancel and leaves the canvas dirty", async () => {
    const { bridge, canvas, store } = await prompted();
    const before = canvas.getState().flow;

    await store.getState().answerClose("cancel");

    expect(store.getState().closePrompt).toBe(false);
    expect(bridge.answerClose.mock.calls).toEqual([["cancel"]]);
    expect(canvas.getState().flow).toBe(before);
    expect(selectDirty(canvas.getState())).toBe(true);
    expect(bridge.saveFlow).not.toHaveBeenCalled();
  });

  it("discard answers close without saving", async () => {
    const { bridge, store } = await prompted();

    await store.getState().answerClose("discard");

    expect(bridge.answerClose.mock.calls).toEqual([["close"]]);
    expect(bridge.saveFlow).not.toHaveBeenCalled();
  });

  it("save answers close only after the save succeeds", async () => {
    const { bridge, canvas, store } = await prompted();
    const sent = canvas.getState().flow;
    const reply = deferred<unknown>();
    bridge.saveFlow.mockReturnValueOnce(reply.promise);

    const answering = store.getState().answerClose("save");

    expect(bridge.saveFlow).toHaveBeenCalledWith(sent);
    expect(bridge.answerClose).not.toHaveBeenCalled();

    reply.resolve({ kind: "saved", flowId: "flow-1", version: 2 });
    await answering;
    await vi.waitFor(() => expect(bridge.answerClose).toHaveBeenCalled());

    expect(bridge.answerClose.mock.calls).toEqual([["close"]]);
    expect(selectDirty(canvas.getState())).toBe(false);
  });

  it("a failed save answers cancel, hides the prompt and shows the error", async () => {
    const { bridge, canvas, store } = await prompted();
    bridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });

    await store.getState().answerClose("save");
    await vi.waitFor(() => expect(bridge.answerClose).toHaveBeenCalled());

    expect(bridge.answerClose.mock.calls).toEqual([["cancel"]]);
    expect(store.getState().closePrompt).toBe(false);
    expect(store.getState().error).toBe("disk full");
    expect(selectDirty(canvas.getState())).toBe(true);
  });

  it("a rejected save answers cancel, hides the prompt and shows the error", async () => {
    const { bridge, canvas, store } = await prompted();
    bridge.saveFlow.mockRejectedValueOnce(new Error("engine exited"));

    await store.getState().answerClose("save");

    expect(bridge.answerClose.mock.calls).toEqual([["cancel"]]);
    expect(store.getState().closePrompt).toBe(false);
    expect(store.getState().error).toBe("engine exited");
    expect(selectDirty(canvas.getState())).toBe(true);
  });
});
