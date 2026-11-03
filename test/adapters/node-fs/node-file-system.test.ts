import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";

describe("NodeFileSystem", () => {
  const fs = new NodeFileSystem();
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fd-node-fs-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates missing folders when writing and reads the file back", async () => {
    await fs.writeFile(join(tmp, "a/b/c.md"), "hello");

    expect(await fs.readFile(join(tmp, "a/b/c.md"))).toBe("hello");
  });

  it("removes one file and nothing else, and does not mind a file already gone", async () => {
    await fs.writeFile(join(tmp, "a/keep.md"), "k");
    await fs.writeFile(join(tmp, "a/drop.md"), "d");

    await fs.remove(join(tmp, "a/drop.md"));
    await fs.remove(join(tmp, "a/drop.md"));

    expect(await fs.list(tmp)).toEqual(["a/keep.md"]);
  });

  it("writes a private file only its owner can read, creating missing folders", async () => {
    const path = join(tmp, "runs/r1/mcp.json");

    await fs.writePrivateFile(path, "secret");

    expect(await fs.readFile(path)).toBe("secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("makes an existing readable file private when writing it privately", async () => {
    const path = join(tmp, "mcp.json");
    await fs.writeFile(path, "old");
    await chmod(path, 0o644);

    await fs.writePrivateFile(path, "new");

    expect(await fs.readFile(path)).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects reading a missing file", async () => {
    await expect(fs.readFile(join(tmp, "missing.md"))).rejects.toThrow();
  });

  it("knows a written file and the folder above it", async () => {
    await fs.writeFile(join(tmp, "a/b/c.md"), "hello");

    expect(await fs.exists(join(tmp, "a/b/c.md"))).toBe(true);
    expect(await fs.exists(join(tmp, "a"))).toBe(true);
    expect(await fs.exists(join(tmp, "missing"))).toBe(false);
  });

  it("reports a path under a regular file as missing", async () => {
    await fs.writeFile(join(tmp, "file.md"), "x");

    expect(await fs.exists(join(tmp, "file.md/inside"))).toBe(false);
  });

  it("rethrows errors other than a missing path", async () => {
    const locked = join(tmp, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await expect(fs.exists(join(locked, "x"))).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("lists files only, recursively, relative and sorted", async () => {
    await fs.writeFile(join(tmp, "z.md"), "z");
    await fs.writeFile(join(tmp, "a/b.md"), "b");

    expect(await fs.list(tmp)).toEqual(["a/b.md", "z.md"]);
  });

  it("rejects listing a missing folder", async () => {
    await expect(fs.list(join(tmp, "missing"))).rejects.toThrow(/ENOENT/);
  });

  it("lists only the folders directly inside a folder, by name and sorted", async () => {
    await fs.writeFile(join(tmp, "z.md"), "z");
    await fs.writeFile(join(tmp, "b/inner/c.md"), "c");
    await mkdir(join(tmp, "a"));

    expect(await fs.folders(tmp)).toEqual(["a", "b"]);
  });

  it("lists no folders inside a missing folder", async () => {
    expect(await fs.folders(join(tmp, "missing"))).toEqual([]);
  });

  it("removes a whole folder tree", async () => {
    const workspace = join(tmp, "workspaces/b1");
    await fs.writeFile(join(workspace, "CLAUDE.md"), "c");
    await fs.writeFile(join(workspace, "plugin/agents/a.md"), "a");
    await fs.writeFile(join(tmp, "workspaces/b2/CLAUDE.md"), "other");

    await fs.removeTree(workspace);

    expect(await fs.exists(workspace)).toBe(false);
    expect(await fs.list(tmp)).toEqual(["workspaces/b2/CLAUDE.md"]);
  });

  it("removes a folder tree except the kept child and everything inside it", async () => {
    const workspace = join(tmp, "b1");
    await fs.writeFile(join(workspace, "CLAUDE.md"), "c");
    await fs.writeFile(join(workspace, "plugin/agents/a.md"), "a");
    await fs.writeFile(join(workspace, "repo/src/work.ts"), "w");
    await fs.writeFile(join(workspace, "repo2/x.md"), "x");
    await mkdir(join(workspace, "repo/empty"));

    await fs.removeTree(workspace, { keep: join(workspace, "repo") });

    expect(await fs.list(workspace)).toEqual(["repo/src/work.ts"]);
    expect(await fs.exists(join(workspace, "repo/empty"))).toBe(true);
    expect(await fs.exists(join(workspace, "plugin"))).toBe(false);
  });
});
