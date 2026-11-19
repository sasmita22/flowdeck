import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
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

  it("replaces a file's content in place of the old one, keeping its mode and leaving no temp file", async () => {
    const path = join(tmp, "claude/.claude.json");
    await fs.writeFile(path, "old");
    await chmod(path, 0o644);

    await fs.replaceFile(path, "new");

    expect(await fs.readFile(path)).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(await fs.list(tmp)).toEqual(["claude/.claude.json"]);
  });

  it("keeps a private file private when replacing it", async () => {
    const path = join(tmp, "secret.json");
    await fs.writePrivateFile(path, "old");

    await fs.replaceFile(path, "new");

    expect(await fs.readFile(path)).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind when the replace fails", async () => {
    const path = join(tmp, "taken");
    await fs.writeFile(join(path, "inside.md"), "kept");

    await expect(fs.replaceFile(path, "new")).rejects.toThrow();

    expect(await fs.list(tmp)).toEqual(["taken/inside.md"]);
  });

  it("rejects replacing a missing file and creates nothing", async () => {
    await expect(fs.replaceFile(join(tmp, "missing.json"), "x")).rejects.toThrow();

    expect(await fs.list(tmp)).toEqual([]);
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

  it("lists without reading inside the skipped folder", async () => {
    await fs.writeFile(join(tmp, "z.md"), "z");
    await fs.writeFile(join(tmp, "a/b.md"), "b");
    await fs.writeFile(join(tmp, "repo/src/work.ts"), "w");
    await fs.writeFile(join(tmp, "repository/x.md"), "x");
    const repo = join(tmp, "repo");
    await chmod(repo, 0o000);
    try {
      expect(await fs.list(tmp, { skip: [repo] })).toEqual(["a/b.md", "repository/x.md", "z.md"]);
    } finally {
      await chmod(repo, 0o700);
    }
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

    await fs.removeTree(workspace, { keep: [join(workspace, "repo")] });

    expect(await fs.list(workspace)).toEqual(["repo/src/work.ts"]);
    expect(await fs.exists(join(workspace, "repo/empty"))).toBe(true);
    expect(await fs.exists(join(workspace, "plugin"))).toBe(false);
  });

  it("removes a folder tree except every kept child and everything inside each", async () => {
    const build = join(tmp, "b1");
    const android = join(build, "sessions/android/android");
    const ios = join(build, "sessions/ios/ios");
    await fs.writeFile(join(build, "workspace/CLAUDE.md"), "w");
    await fs.writeFile(join(build, "sessions/android/CLAUDE.md"), "a");
    await fs.writeFile(join(android, "src/work.kt"), "k");
    await fs.writeFile(join(build, "sessions/ios/plugin/agents/plan.md"), "p");
    await fs.writeFile(join(ios, "src/work.swift"), "s");
    await mkdir(join(ios, "empty"));

    await fs.removeTree(build, { keep: [android, ios] });

    expect(await fs.list(build)).toEqual([
      "sessions/android/android/src/work.kt",
      "sessions/ios/ios/src/work.swift",
    ]);
    expect(await fs.exists(join(ios, "empty"))).toBe(true);
    expect(await fs.exists(join(build, "workspace"))).toBe(false);
  });

  describe("entries", () => {
    let build: string;
    let outside: string;

    beforeEach(async () => {
      build = join(tmp, "build");
      outside = join(tmp, "build-outside");
      await fs.writeFile(join(build, "node_modules/a/b/c.js"), "c");
      await fs.writeFile(join(build, "src/x.ts"), "x");
      await fs.writeFile(join(build, "README.md"), "r");
      await fs.writeFile(join(outside, "secret.md"), "s");
    });

    it("lists one level only, folders before files, each sorted", async () => {
      expect(await fs.entries(build, { inside: build })).toEqual([
        { name: "node_modules", kind: "folder" },
        { name: "src", kind: "folder" },
        { name: "README.md", kind: "file" },
      ]);
      expect(await fs.entries(join(build, "node_modules"), { inside: build })).toEqual([
        { name: "a", kind: "folder" },
      ]);
    });

    it("leaves out symlinked files and folders", async () => {
      await symlink(join(outside, "secret.md"), join(build, "linked-file"));
      await symlink(outside, join(build, "linked-folder"));

      expect(await fs.entries(build, { inside: build })).toEqual([
        { name: "node_modules", kind: "folder" },
        { name: "src", kind: "folder" },
        { name: "README.md", kind: "file" },
      ]);
    });

    it("refuses a folder whose real path leaves the folder it must stay inside", async () => {
      await symlink(outside, join(build, "link-to-outside"));

      await expect(fs.entries(join(build, "link-to-outside"), { inside: build })).rejects.toThrow();
    });

    it.each([
      ["the parent folder", () => join(build, "..")],
      ["a sibling folder sharing its name as a prefix", () => outside],
      ["an absolute path elsewhere", () => tmpdir()],
    ])("refuses %s", async (_, dir) => {
      await expect(fs.entries(dir(), { inside: build })).rejects.toThrow();
    });

    it("compares real paths, so a folder reached through another path still counts as inside", async () => {
      const alias = join(tmp, "alias");
      await symlink(build, alias);

      expect(await fs.entries(await realpath(build), { inside: build })).toHaveLength(3);
      expect(await fs.entries(build, { inside: await realpath(build) })).toHaveLength(3);
      expect(await fs.entries(join(alias, "src"), { inside: build })).toEqual([
        { name: "x.ts", kind: "file" },
      ]);
      expect(await fs.entries(join(build, "src"), { inside: alias })).toEqual([
        { name: "x.ts", kind: "file" },
      ]);
    });
  });

  describe("realPath", () => {
    it("resolves a folder reached through a link to the folder it points at", async () => {
      const real = join(tmp, "real");
      const alias = join(tmp, "alias");
      await mkdir(real);
      await symlink(real, alias);

      expect(await fs.realPath(alias)).toBe(await realpath(real));
    });

    it("resolves a folder not made yet through the link above it", async () => {
      const real = join(tmp, "real");
      const alias = join(tmp, "alias");
      await mkdir(real);
      await symlink(real, alias);

      expect(await fs.realPath(join(alias, "workspaces", "b1"))).toBe(
        join(await realpath(real), "workspaces", "b1"),
      );
    });
  });
});
