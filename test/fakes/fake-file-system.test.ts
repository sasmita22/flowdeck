import { describe, expect, it } from "vitest";
import { FakeFileSystem } from "./fake-file-system.js";

describe("FakeFileSystem", () => {
  it("reads back what was written", async () => {
    const fs = new FakeFileSystem();

    await fs.writeFile("a/b/c.md", "hello");

    expect(await fs.readFile("a/b/c.md")).toBe("hello");
  });

  it("removes one file and nothing else, and does not mind a file already gone", async () => {
    const fs = new FakeFileSystem({ "a/keep.md": "k", "a/drop.md": "d" });

    await fs.remove("a/drop.md");
    await fs.remove("a/drop.md");

    expect(await fs.list("a")).toEqual(["keep.md"]);
    expect(fs.calls.filter((call) => call.method === "remove")).toHaveLength(2);
  });

  it("reads back a private file and remembers it was written privately", async () => {
    const fs = new FakeFileSystem();

    await fs.writeFile("a/open.md", "o");
    await fs.writePrivateFile("a/secret.json", "s");

    expect(await fs.readFile("a/secret.json")).toBe("s");
    expect(fs.isPrivate("a/secret.json")).toBe(true);
    expect(fs.isPrivate("a/open.md")).toBe(false);
  });

  it("removes every file under a folder tree and records the call", async () => {
    const fs = new FakeFileSystem({
      "ws/b1/CLAUDE.md": "c",
      "ws/b1/plugin/agents/a.md": "a",
      "ws/b10/CLAUDE.md": "other",
    });

    await fs.removeTree("ws/b1");

    expect(await fs.exists("ws/b1")).toBe(false);
    expect(await fs.list("ws")).toEqual(["b10/CLAUDE.md"]);
    expect(fs.calls).toContainEqual({ method: "removeTree", path: "ws/b1" });
  });

  it("removes a folder tree except the files under the kept child", async () => {
    const fs = new FakeFileSystem({
      "ws/b1/CLAUDE.md": "c",
      "ws/b1/repo/src/work.ts": "w",
      "ws/b1/repo2/x.md": "x",
    });

    await fs.removeTree("ws/b1", { keep: "ws/b1/repo" });

    expect(await fs.list("ws/b1")).toEqual(["repo/src/work.ts"]);
  });

  it("rejects reading a missing file", async () => {
    await expect(new FakeFileSystem().readFile("missing.md")).rejects.toThrow();
  });

  it("knows a written file and the folders above it", async () => {
    const fs = new FakeFileSystem();

    await fs.writeFile("a/b/c.md", "hello");

    expect(await fs.exists("a/b/c.md")).toBe(true);
    expect(await fs.exists("a")).toBe(true);
    expect(await fs.exists("a/b/c")).toBe(false);
    expect(await fs.exists("elsewhere")).toBe(false);
  });

  it("lists every file under a folder, relative and sorted", async () => {
    const fs = new FakeFileSystem();

    await fs.writeFile("root/z.md", "z");
    await fs.writeFile("root/a/b.md", "b");
    await fs.writeFile("other/x.md", "x");

    expect(await fs.list("root")).toEqual(["a/b.md", "z.md"]);
  });

  it("lists only the folders directly inside a folder, by name and sorted, and records the call", async () => {
    const fs = new FakeFileSystem();
    await fs.writeFile("root/z.md", "z");
    await fs.writeFile("root/b/inner/c.md", "c");
    await fs.writeFile("root/a/x.md", "x");
    await fs.writeFile("rooted/d/y.md", "y");

    expect(await fs.folders("root")).toEqual(["a", "b"]);
    expect(await fs.folders("missing")).toEqual([]);
    expect(fs.calls.filter((call) => call.method === "folders")).toEqual([
      { method: "folders", path: "root" },
      { method: "folders", path: "missing" },
    ]);
  });

  it("rejects listing a missing folder", async () => {
    const fs = new FakeFileSystem();
    await fs.writeFile("root/a.md", "a");

    await expect(fs.list("missing")).rejects.toThrow(/ENOENT/);
    await expect(fs.list("roo")).rejects.toThrow(/ENOENT/);
  });

  it("serves seeded files without recording them as calls", async () => {
    const fs = new FakeFileSystem({ "seed/one.md": "one" });

    expect(fs.calls).toEqual([]);
    expect(await fs.exists("seed/one.md")).toBe(true);
    expect(await fs.readFile("seed/one.md")).toBe("one");
  });

  it("records every call in order", async () => {
    const fs = new FakeFileSystem();

    await fs.exists("a");
    await fs.writeFile("a/x.md", "x");
    await fs.readFile("a/x.md");
    await fs.list("a");

    expect(fs.calls).toEqual([
      { method: "exists", path: "a" },
      { method: "writeFile", path: "a/x.md" },
      { method: "readFile", path: "a/x.md" },
      { method: "list", path: "a" },
    ]);
  });
});
