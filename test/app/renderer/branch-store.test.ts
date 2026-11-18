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
    expect(store.getState().byRepo["/code/shop"]).toEqual({
      branches: ["dev", "main"],
      error: null,
    });
  });

  it("asks once per repository, even with another repository asked in between", async () => {
    const listBranches = vi.fn(async ({ repo }: { repo: string }) => [`${repo}-main`]);
    const store = createBranchStore({ bridge: { listBranches, pickFolder: noFolder } });

    await store.getState().load("/code/shop");
    await store.getState().load("/code/blog");
    await store.getState().load("/code/shop");

    expect(listBranches).toHaveBeenCalledTimes(2);
  });

  it("keeps each repository's branches, so two sessions on different repositories each see their own", async () => {
    const listBranches = vi.fn(async ({ repo }: { repo: string }) =>
      repo === "/code/shop" ? ["shop-main"] : ["blog-main", "blog-dev"],
    );
    const store = createBranchStore({ bridge: { listBranches, pickFolder: noFolder } });

    await store.getState().load("/code/shop");
    await store.getState().load("/code/blog");

    expect(store.getState().byRepo).toEqual({
      "/code/shop": { branches: ["shop-main"], error: null },
      "/code/blog": { branches: ["blog-main", "blog-dev"], error: null },
    });
  });

  it("says plainly when the folder is not a repository, for that repository only", async () => {
    const store = createBranchStore({
      bridge: {
        listBranches: async ({ repo }: { repo: string }) => {
          if (repo === "/code/shop") return ["main"];
          throw new Error(
            "Error invoking remote method 'flowdeck:list-branches': Error: /code/x is not a git repository",
          );
        },
        pickFolder: noFolder,
      },
    });

    await store.getState().load("/code/shop");
    await store.getState().load("/code/x");

    expect(store.getState().byRepo).toEqual({
      "/code/shop": { branches: ["main"], error: null },
      "/code/x": { branches: null, error: "/code/x is not a git repository" },
    });
  });

  it("asks nothing and keeps every list for a blank repository", async () => {
    const listBranches = vi.fn(async () => ["main"]);
    const store = createBranchStore({ bridge: { listBranches, pickFolder: noFolder } });
    await store.getState().load("/code/shop");
    const before = store.getState().byRepo;

    await store.getState().load("  ");

    expect(listBranches).toHaveBeenCalledTimes(1);
    expect(store.getState().byRepo).toEqual(before);
  });

  it("files a slow answer under the repository it was asked for", async () => {
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

    expect(store.getState().byRepo).toEqual({
      "/code/shop": { branches: ["shop-main"], error: null },
      "/code/blog": { branches: ["blog-main"], error: null },
    });
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
    expect(store.getState().byRepo["/repo"]).toEqual({ branches: ["dev", "main"], error: null });
  });

  it("changes nothing when the picker is cancelled", async () => {
    const pickFolder = vi.fn(async () => null);
    const listBranches = vi.fn(async () => ["main"]);
    const commit = vi.fn();
    const store = createBranchStore({ bridge: { listBranches, pickFolder } });
    await store.getState().load("/code/shop");
    listBranches.mockClear();
    const before = store.getState().byRepo;

    await store.getState().browse(commit);

    expect(commit).not.toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();
    expect(store.getState().byRepo).toEqual(before);
  });
});
