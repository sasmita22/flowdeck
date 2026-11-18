import { describe, expect, it, vi } from "vitest";
import {
  createFullTextStore,
  selectFullText,
} from "../../../../src/app/renderer/inspector/full-text-store.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const setup = (answer: (ownerId: string, entryId: number) => Promise<unknown>) => {
  const fetch = vi.fn(answer);
  const store = createFullTextStore({ fetch });
  const shown = (ownerId: string, entryId: number) =>
    selectFullText(store.getState(), ownerId, entryId);
  return { fetch, store, shown };
};

describe("request", () => {
  it("is loading until the fetch answers, then holds the kept texts", async () => {
    const answer = deferred<unknown>();
    const { fetch, store, shown } = setup(() => answer.promise);

    const requested = store.getState().request("run-1", 3);

    expect(fetch).toHaveBeenCalledWith("run-1", 3);
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

  it("ends failed with the error message when the fetch rejects", async () => {
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

  it("fetches once per step", async () => {
    const { fetch, store } = setup(async () => ({ kept: false }));

    await store.getState().request("run-1", 3);
    await store.getState().request("run-1", 3);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps steps of different owners apart", async () => {
    const { fetch, store, shown } = setup(async (ownerId) =>
      ownerId === "run-1" ? { kept: true, texts: { output: "from run 1" } } : { kept: false },
    );

    await store.getState().request("run-1", 3);
    await store.getState().request("run-2", 3);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(shown("run-1", 3)).toEqual({ kind: "kept", texts: { output: "from run 1" } });
    expect(shown("run-2", 3)).toEqual({ kind: "not-kept" });
    expect(shown("run-3", 3)).toBeUndefined();
  });

  it("never shares a step between two stores", async () => {
    const runs = setup(async () => ({ kept: true, texts: { output: "from the run" } }));
    const builds = setup(async () => ({ kept: true, texts: { output: "from the build" } }));

    await runs.store.getState().request("same-id", 3);
    await builds.store.getState().request("same-id", 3);

    expect(builds.fetch).toHaveBeenCalledWith("same-id", 3);
    expect(runs.shown("same-id", 3)).toEqual({ kind: "kept", texts: { output: "from the run" } });
    expect(builds.shown("same-id", 3)).toEqual({
      kind: "kept",
      texts: { output: "from the build" },
    });
  });
});
