import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpRepo, type TmpRepo } from "./tmp-repo.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("createTmpRepo", () => {
  const made: TmpRepo[] = [];

  afterEach(async () => {
    for (const repo of made.splice(0)) await repo.cleanup();
  });

  it("makes a git repo under the real temp folder, named by its own realpath", async () => {
    const repo = await createTmpRepo();
    made.push(repo);

    expect(repo.path.startsWith((await realpath(tmpdir())) + sep)).toBe(true);
    expect(await realpath(repo.path)).toBe(repo.path);
    expect((await stat(join(repo.path, ".git"))).isDirectory()).toBe(true);
  });

  it("makes a different folder each time", async () => {
    const first = await createTmpRepo();
    const second = await createTmpRepo();
    made.push(first, second);

    expect(first.path).not.toBe(second.path);
  });

  it("removes the folder on cleanup", async () => {
    const repo = await createTmpRepo();

    await repo.cleanup();

    expect(await exists(repo.path)).toBe(false);
  });
});
