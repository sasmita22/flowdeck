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
  "saveFlow" | "openFlow" | "renameFlow" | "setDirty" | "onCloseRequest" | "answerClose"
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
    openFlow: vi.fn<(payload: { flowId?: string }) => Promise<unknown>>(async () => {
      const latest = await (options.latest ?? (() => Promise.resolve(null)))();
      return latest === null
        ? null
        : { flowId: "flow-1", name: "Untitled", version: 1, flow: latest };
    }),
    renameFlow: vi.fn<(payload: { flowId: string; name: string }) => Promise<unknown>>(
      async () => null,
    ),
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
    const { bridge, canvas, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    makeDirty(canvas);
    const sent = canvas.getState().flow;
    const reply = deferred<unknown>();
    bridge.saveFlow.mockReturnValueOnce(reply.promise);

    const saving = store.getState().save();

    expect(bridge.saveFlow).toHaveBeenCalledTimes(1);
    expect(bridge.saveFlow).toHaveBeenCalledWith({
      flowId: "flow-1",
      name: "Untitled",
      flow: sent,
    });
    expect(store.getState().saving).toBe(true);

    reply.resolve({ kind: "saved", flowId: "flow-1", version: 2 });

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
    expect(bridge.saveFlow).toHaveBeenCalledWith({ flowId: null, name: "Untitled", flow: sent });
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

    expect(bridge.saveFlow).toHaveBeenCalledWith({
      flowId: "flow-1",
      name: "Untitled",
      flow: sent,
    });
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

describe("blueprints", () => {
  it("opens the blueprint asked for, holding its id, name and version", async () => {
    const { bridge, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    bridge.openFlow.mockResolvedValueOnce({
      flowId: "flow-2",
      name: "Weekly",
      version: 3,
      flow: savedFlow(),
    });

    await store.getState().open("flow-2");

    expect(bridge.openFlow).toHaveBeenLastCalledWith({ flowId: "flow-2" });
    expect(store.getState()).toMatchObject({
      flowId: "flow-2",
      name: "Weekly",
      version: 3,
      hasSavedVersion: true,
    });
  });

  it("opens a blueprint never saved as an empty, clean canvas under its name", async () => {
    const { bridge, canvas, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    bridge.openFlow.mockResolvedValueOnce({
      flowId: "flow-2",
      name: "Fresh",
      version: null,
      flow: null,
    });

    await store.getState().open("flow-2");

    expect(canvas.getState().flow).toEqual(newCanvasFlow());
    expect(selectDirty(canvas.getState())).toBe(false);
    expect(store.getState()).toMatchObject({
      flowId: "flow-2",
      name: "Fresh",
      version: null,
      hasSavedVersion: false,
    });
  });

  it("starts with no blueprint, named Untitled, when nothing exists", async () => {
    const { store } = await setup();

    expect(store.getState()).toMatchObject({ flowId: null, name: "Untitled", version: null });
  });

  it("creates the blueprint under its title on the first save, then saves to it", async () => {
    const { bridge, canvas, store } = await setup();
    await store.getState().rename("Release notes");
    makeDirty(canvas);
    bridge.saveFlow
      .mockResolvedValueOnce({ kind: "saved", flowId: "flow-9", version: 1 })
      .mockResolvedValueOnce({ kind: "saved", flowId: "flow-9", version: 2 });

    await store.getState().save();
    makeDirty(canvas);
    await store.getState().save();

    expect(bridge.renameFlow).not.toHaveBeenCalled();
    expect(
      bridge.saveFlow.mock.calls.map(([payload]) => (payload as { flowId: unknown }).flowId),
    ).toEqual([null, "flow-9"]);
    expect(bridge.saveFlow.mock.calls[0]?.[0]).toMatchObject({ name: "Release notes" });
    expect(store.getState()).toMatchObject({ flowId: "flow-9", version: 2 });
  });

  it("renames a saved blueprint in the store, and keeps the old name when that fails", async () => {
    const { bridge, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });

    await store.getState().rename("Weekly");
    expect(bridge.renameFlow).toHaveBeenLastCalledWith({ flowId: "flow-1", name: "Weekly" });
    expect(store.getState().name).toBe("Weekly");

    bridge.renameFlow.mockRejectedValueOnce(new Error("A blueprint needs a name"));
    await store.getState().rename(" ");
    expect(store.getState()).toMatchObject({ name: "Weekly", error: "A blueprint needs a name" });
  });

  it("starts a new blueprint as an empty canvas with no id", async () => {
    const { canvas, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });

    store.getState().startNew();

    expect(canvas.getState().flow).toEqual(newCanvasFlow());
    expect(store.getState()).toMatchObject({
      flowId: null,
      name: "Untitled",
      version: null,
      hasSavedVersion: false,
    });
  });
});

describe("leaving unsaved changes", () => {
  it("goes straight on when the canvas is clean", async () => {
    const { store } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    const next = vi.fn(async () => undefined);

    await store.getState().leave(next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(store.getState().leavePrompt).toBe(false);
  });

  it("asks first when the canvas is dirty, and cancel keeps the edit", async () => {
    const { canvas, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    makeDirty(canvas);
    const next = vi.fn(async () => undefined);

    await store.getState().leave(next);
    expect(store.getState().leavePrompt).toBe(true);
    expect(next).not.toHaveBeenCalled();

    await store.getState().answerLeave("cancel");
    expect(store.getState().leavePrompt).toBe(false);
    expect(next).not.toHaveBeenCalled();
    expect(selectDirty(canvas.getState())).toBe(true);
  });

  it("saves then goes on, or goes on without saving, or stays when the save fails", async () => {
    const { bridge, canvas, store } = await setup({ latest: () => Promise.resolve(savedFlow()) });
    const next = vi.fn(async () => undefined);

    makeDirty(canvas);
    await store.getState().leave(next);
    await store.getState().answerLeave("save");
    expect(bridge.saveFlow).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);

    makeDirty(canvas);
    await store.getState().leave(next);
    await store.getState().answerLeave("discard");
    expect(bridge.saveFlow).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);

    bridge.saveFlow.mockResolvedValueOnce({ kind: "error", message: "disk full" });
    await store.getState().leave(next);
    await store.getState().answerLeave("save");
    expect(next).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ leavePrompt: false, error: "disk full" });
  });
});
