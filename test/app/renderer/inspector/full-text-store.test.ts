import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import {
  createFullTextStore,
  selectFullText,
} from "../../../../src/app/renderer/inspector/full-text-store.js";

type FullTextBridge = Pick<FlowdeckBridge, "stepFullText">;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const setup = (answer: (payload: { runId: string; entryId: number }) => Promise<unknown>) => {
  const bridge = { stepFullText: vi.fn(answer) } satisfies FullTextBridge;
  const store = createFullTextStore({ bridge });
  const shown = (runId: string, entryId: number) =>
    selectFullText(store.getState(), runId, entryId);
  return { bridge, store, shown };
};

describe("request", () => {
  it("is loading until the bridge answers, then holds the kept texts", async () => {
    const answer = deferred<unknown>();
    const { bridge, store, shown } = setup(() => answer.promise);

    const requested = store.getState().request("run-1", 3);

    expect(bridge.stepFullText).toHaveBeenCalledWith({ runId: "run-1", entryId: 3 });
    expect(shown("run-1", 3)).toEqual({ kind: "loading" });
    answer.resolve({ kept: true, texts: { input: "full input", output: "full output" } });
    await requested;
    expect(shown("run-1", 3)).toEqual({
      kind: "kept",
      texts: { input: "full input", output: "full output" },
    });
  });

  it("ends not-kept when the engine kept no full text", async () => {
    const { store, shown } = setup(async () => ({ kept: false }));

    await store.getState().request("run-1", 3);

    expect(shown("run-1", 3)).toEqual({ kind: "not-kept" });
  });

  it("ends failed with the error message when the bridge rejects", async () => {
    const { store, shown } = setup(async () => {
      throw new Error("No run run-1");
    });

    await store.getState().request("run-1", 3);

    expect(shown("run-1", 3)).toEqual({ kind: "failed", error: "No run run-1" });
  });

  it("ends failed when the answer is not one the engine sends", async () => {
    const { store, shown } = setup(async () => ({ kept: true, texts: { stdout: "x" } }));

    await store.getState().request("run-1", 3);

    expect(shown("run-1", 3)).toEqual({
      kind: "failed",
      error: "The engine sent an unreadable answer",
    });
  });

  it("asks the bridge once per step", async () => {
    const { bridge, store } = setup(async () => ({ kept: false }));

    await store.getState().request("run-1", 3);
    await store.getState().request("run-1", 3);

    expect(bridge.stepFullText).toHaveBeenCalledTimes(1);
  });

  it("keeps steps of different runs apart", async () => {
    const { bridge, store, shown } = setup(async ({ runId }) =>
      runId === "run-1" ? { kept: true, texts: { output: "from run 1" } } : { kept: false },
    );

    await store.getState().request("run-1", 3);
    await store.getState().request("run-2", 3);

    expect(bridge.stepFullText).toHaveBeenCalledTimes(2);
    expect(shown("run-1", 3)).toEqual({ kind: "kept", texts: { output: "from run 1" } });
    expect(shown("run-2", 3)).toEqual({ kind: "not-kept" });
    expect(shown("run-3", 3)).toBeUndefined();
  });
});
