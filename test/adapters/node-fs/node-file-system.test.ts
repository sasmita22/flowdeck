import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
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
});
