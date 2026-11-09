import { describe, expect, it, vi } from "vitest";
import { createBranchStore } from "../../../src/app/renderer/branch-store.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const noFolder = async () => null;

describe("createBranchStore", () => {
  it("lists a repository's branches through the bridge", async () => {
    const listBranches = vi.fn(async () => ["dev", "main"]);
    const store = createBranchStore({ bridge: { listBranches, pickFolder: noFolder } });

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
    const store = createBranchStore({ bridge: { listBranches, pickFolder: noFolder } });

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
        pickFolder: noFolder,
      },
    });

    await store.getState().load("/code/x");

    expect(store.getState()).toMatchObject({
      branches: null,
      error: "/code/x is not a git repository",
    });
  });

  it("forgets the branches for a blank repository", async () => {
    const store = createBranchStore({
      bridge: { listBranches: async () => ["main"], pickFolder: noFolder },
    });
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
    const store = createBranchStore({ bridge: { listBranches, pickFolder: noFolder } });

    const slow = store.getState().load("/code/shop");
    await store.getState().load("/code/blog");
    first.resolve(["shop-main"]);
    await slow;

    expect(store.getState()).toMatchObject({ repo: "/code/blog", branches: ["blog-main"] });
  });
});

describe("createBranchStore browse", () => {
  it("commits the picked folder and loads its branches", async () => {
    const pickFolder = vi.fn(async () => "/repo");
    const listBranches = vi.fn(async () => ["dev", "main"]);
    const commit = vi.fn();
    const store = createBranchStore({ bridge: { listBranches, pickFolder } });

    await store.getState().browse(commit);

    expect(commit).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(listBranches).toHaveBeenCalledWith({ repo: "/repo" });
    expect(store.getState()).toMatchObject({
      repo: "/repo",
      branches: ["dev", "main"],
      error: null,
    });
  });

  it("changes nothing when the picker is cancelled", async () => {
    const pickFolder = vi.fn(async () => null);
    const listBranches = vi.fn(async () => ["main"]);
    const commit = vi.fn();
    const store = createBranchStore({ bridge: { listBranches, pickFolder } });
    await store.getState().load("/code/shop");
    listBranches.mockClear();
    const before = store.getState();

    await store.getState().browse(commit);

    expect(commit).not.toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      repo: before.repo,
      branches: before.branches,
      error: before.error,
    });
  });
});
