import { describe, expect, it } from "vitest";
import { FakeFileSystem } from "./fake-file-system.js";

describe("FakeFileSystem", () => {
  it("reads back what was written", async () => {
    const fs = new FakeFileSystem();

    await fs.writeFile("a/b/c.md", "hello");

    expect(await fs.readFile("a/b/c.md")).toBe("hello");
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
