import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorktree } from "./fake-worktree.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("FakeWorktree", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fd-fake-worktree-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records each call's options in order", async () => {
    const worktree = new FakeWorktree();
    const first = {
      repo: "/r",
      base: "main",
      branch: "flowdeck/a",
      path: join(root, "a"),
      create: true,
    };
    const second = {
      repo: "/r",
      base: "dev",
      branch: "flowdeck/b",
      path: join(root, "b"),
      create: false,
    };

    await worktree.add(first);
    await worktree.add(second);

    expect(worktree.calls).toEqual([first, second]);
  });

  it("holds several worktrees by path and removing one leaves the other", async () => {
    const worktree = new FakeWorktree();
    const android = {
      repo: "/repos/android",
      base: "main",
      branch: "fd-android",
      path: join(root, "sessions/android/android"),
      create: true,
    };
    const ios = {
      repo: "/repos/ios",
      base: "develop",
      branch: "fd-ios",
      path: join(root, "sessions/ios/ios"),
      create: true,
    };

    await worktree.add(android);
    await worktree.add(ios);

    expect(worktree.worktrees).toEqual(
      new Map([
        [android.path, { repo: "/repos/android", base: "main", branch: "fd-android" }],
        [ios.path, { repo: "/repos/ios", base: "develop", branch: "fd-ios" }],
      ]),
    );

    await worktree.remove(android);

    expect(worktree.worktrees).toEqual(
      new Map([[ios.path, { repo: "/repos/ios", base: "develop", branch: "fd-ios" }]]),
    );
    expect(await exists(ios.path)).toBe(true);
  });

  it("creates the worktree folder", async () => {
    const path = join(root, "worktrees", "abcd1234");

    await new FakeWorktree().add({
      repo: "/r",
      base: "main",
      branch: "flowdeck/x",
      path,
      create: true,
    });

    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it("rejects with the scripted failure, records the call and creates nothing", async () => {
    const worktree = new FakeWorktree({ failWith: "Base branch nope not found in /r" });
    const options = {
      repo: "/r",
      base: "nope",
      branch: "flowdeck/x",
      path: join(root, "x"),
      create: true,
    };

    await expect(worktree.add(options)).rejects.toThrow("Base branch nope not found in /r");
    expect(worktree.calls).toEqual([options]);
    expect(await exists(options.path)).toBe(false);
  });

  it("records each removal and deletes the worktree folder", async () => {
    const worktree = new FakeWorktree();
    const path = join(root, "worktrees", "abcd1234");
    const options = { repo: "/r", base: "main", branch: "flowdeck/abcd1234", path, create: true };
    await worktree.add(options);

    expect(await worktree.remove(options)).toEqual({ worktree: "removed", branch: "removed" });

    expect(worktree.removed).toEqual([options]);
    expect(await exists(path)).toBe(false);
  });

  it("holds a branch it creates until the worktree is removed", async () => {
    const worktree = new FakeWorktree();
    const options = {
      repo: "/r",
      base: "main",
      branch: "flowdeck/a",
      path: join(root, "a"),
      create: true,
    };

    await worktree.add(options);
    expect(worktree.branches).toEqual(new Set(["flowdeck/a"]));

    await worktree.remove(options);
    expect(worktree.branches).toEqual(new Set());
  });

  it("keeps a branch it did not create when removing the worktree", async () => {
    const worktree = new FakeWorktree();
    const path = join(root, "feat-y");
    const options = { repo: "/r", base: "main", branch: "feat-y", path, create: false };
    await worktree.add(options);

    expect(await worktree.remove(options)).toEqual({ worktree: "removed", branch: "kept" });

    expect(worktree.removed).toEqual([options]);
    expect(worktree.branches).toEqual(new Set(["feat-y"]));
    expect(await exists(path)).toBe(false);
  });

  it("keeps a dirty worktree and its branch unless forced, then removes both", async () => {
    const path = join(root, "worktrees", "abcd1234");
    const worktree = new FakeWorktree({ dirty: [path] });
    const options = { repo: "/r", base: "main", branch: "flowdeck/abcd1234", path, create: true };
    await worktree.add(options);

    expect(await worktree.remove(options)).toEqual({ worktree: "kept", branch: "kept" });
    expect(await exists(path)).toBe(true);
    expect(worktree.branches).toEqual(new Set(["flowdeck/abcd1234"]));

    expect(await worktree.remove({ ...options, force: true })).toEqual({
      worktree: "removed",
      branch: "removed",
    });
    expect(await exists(path)).toBe(false);
    expect(worktree.branches).toEqual(new Set());
  });

  it("reads a scripted folder as dirty and any other as clean", async () => {
    const worktree = new FakeWorktree({ dirty: ["/w/a"] });

    expect(await worktree.isDirty("/w/a")).toBe(true);
    expect(await worktree.isDirty("/w/b")).toBe(false);
  });

  it("finds a scripted branch unpushed and any other not", async () => {
    const worktree = new FakeWorktree({ unpushed: ["flowdeck/a"] });

    expect(await worktree.hasUnpushed("/r", "flowdeck/a", "main")).toBe(true);
    expect(await worktree.hasUnpushed("/r", "flowdeck/b", "main")).toBe(false);
  });

  it("records each deleted branch in order", async () => {
    const worktree = new FakeWorktree();

    await worktree.deleteBranch("/r", "flowdeck/a");
    await worktree.deleteBranch("/s", "flowdeck/b");

    expect(worktree.deletedBranches).toEqual([
      { repo: "/r", branch: "flowdeck/a" },
      { repo: "/s", branch: "flowdeck/b" },
    ]);
  });

  it("records each remote branch delete in order", async () => {
    const worktree = new FakeWorktree();

    expect(await worktree.deleteRemoteBranch("/r", "flowdeck/a", "a1")).toEqual([]);
    await worktree.deleteRemoteBranch("/s", "flowdeck/b", "b1");

    expect(worktree.deletedRemoteBranches).toEqual([
      { repo: "/r", branch: "flowdeck/a", tip: "a1" },
      { repo: "/s", branch: "flowdeck/b", tip: "b1" },
    ]);
  });

  it("reads a tip for a branch until it is deleted or removed with its worktree", async () => {
    const worktree = new FakeWorktree();
    const made = { repo: "/r", base: "main", path: "/w", create: true };

    expect(await worktree.branchTip("/r", "flowdeck/a")).toBe("tip-of-flowdeck/a");
    await worktree.deleteBranch("/r", "flowdeck/a");
    await worktree.remove({ ...made, branch: "flowdeck/b", force: true });
    await worktree.remove({ ...made, branch: "flowdeck/c", create: false, force: true });

    expect(await worktree.branchTip("/r", "flowdeck/a")).toBeUndefined();
    expect(await worktree.branchTip("/r", "flowdeck/b")).toBeUndefined();
    expect(await worktree.branchTip("/r", "flowdeck/c")).toBe("tip-of-flowdeck/c");
  });

  it("no longer finds a branch pushed once its remote branch is deleted", async () => {
    const worktree = new FakeWorktree();
    expect(await worktree.hasUnpushed("/r", "flowdeck/a", "main")).toBe(false);

    await worktree.deleteRemoteBranch("/r", "flowdeck/a", "a1");

    expect(await worktree.hasUnpushed("/r", "flowdeck/a", "main")).toBe(true);
    expect(await worktree.hasUnpushed("/r", "flowdeck/b", "main")).toBe(false);
  });

  it("reads the repo and branch of a worktree it added until it is removed", async () => {
    const worktree = new FakeWorktree();
    const options = {
      repo: "/r",
      base: "main",
      branch: "flowdeck/a",
      path: join(root, "a"),
      create: true,
    };
    await worktree.add(options);

    expect(await worktree.checkoutAt(options.path)).toEqual({
      path: options.path,
      repo: "/r",
      branch: "flowdeck/a",
    });

    await worktree.remove(options);

    expect(await worktree.checkoutAt(options.path)).toBeUndefined();
  });

  it("reads nothing at a folder it holds no worktree for", async () => {
    expect(await new FakeWorktree().checkoutAt(join(root, "unknown"))).toBeUndefined();
  });
});
