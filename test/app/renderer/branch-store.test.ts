import { describe, expect, it, vi } from "vitest";
import { createBranchStore } from "../../../src/app/renderer/branch-store.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("createBranchStore", () => {
  it("lists a repository's branches through the bridge", async () => {
    const listBranches = vi.fn(async () => ["dev", "main"]);
    const store = createBranchStore({ bridge: { listBranches } });

    await store.getState().load("/code/shop");

    expect(listBranches).toHaveBeenCalledWith({ repo: "/code/shop" });
    expect(store.getState()).toMatchObject({
      repo: "/code/shop",
      branches: ["dev", "main"],
      error: null,
    });
  });

  it("asks once per repository", async () => {
    const listBranches = vi.fn(async () => ["main"]);
    const store = createBranchStore({ bridge: { listBranches } });

    await store.getState().load("/code/shop");
    await store.getState().load("/code/shop");

    expect(listBranches).toHaveBeenCalledTimes(1);
  });

  it("says plainly when the folder is not a repository, and offers no branches", async () => {
    const store = createBranchStore({
      bridge: {
        listBranches: async () => {
          throw new Error(
            "Error invoking remote method 'flowdeck:list-branches': Error: /code/x is not a git repository",
          );
        },
      },
    });

    await store.getState().load("/code/x");

    expect(store.getState()).toMatchObject({
      branches: null,
      error: "/code/x is not a git repository",
    });
  });

  it("forgets the branches for a blank repository", async () => {
    const store = createBranchStore({ bridge: { listBranches: async () => ["main"] } });
    await store.getState().load("/code/shop");

    await store.getState().load("  ");

    expect(store.getState()).toMatchObject({ repo: null, branches: null, error: null });
  });

  it("keeps only the answer for the repository asked last", async () => {
    const first = deferred<unknown>();
    const listBranches = vi
      .fn<(payload: { repo: string }) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(["blog-main"]);
    const store = createBranchStore({ bridge: { listBranches } });

    const slow = store.getState().load("/code/shop");
    await store.getState().load("/code/blog");
    first.resolve(["shop-main"]);
    await slow;

    expect(store.getState()).toMatchObject({ repo: "/code/blog", branches: ["blog-main"] });
  });
});
