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
    const first = { repo: "/r", base: "main", branch: "flowdeck/a", path: join(root, "a") };
    const second = { repo: "/r", base: "dev", branch: "flowdeck/b", path: join(root, "b") };

    await worktree.add(first);
    await worktree.add(second);

    expect(worktree.calls).toEqual([first, second]);
  });

  it("creates the worktree folder", async () => {
    const path = join(root, "worktrees", "abcd1234");

    await new FakeWorktree().add({ repo: "/r", base: "main", branch: "flowdeck/x", path });

    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it("rejects with the scripted failure, records the call and creates nothing", async () => {
    const worktree = new FakeWorktree({ failWith: "Base branch nope not found in /r" });
    const options = { repo: "/r", base: "nope", branch: "flowdeck/x", path: join(root, "x") };

    await expect(worktree.add(options)).rejects.toThrow("Base branch nope not found in /r");
    expect(worktree.calls).toEqual([options]);
    expect(await exists(options.path)).toBe(false);
  });
});
