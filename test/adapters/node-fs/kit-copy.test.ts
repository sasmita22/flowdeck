import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareKit } from "../../../src/adapters/node-fs/kit-copy.js";
import { kitVersion } from "../../../src/core/compiler/kit-version.js";

const kitFiles = [
  { path: ".claude-plugin/plugin.json", content: '{ "name": "flowdeck-build" }\n' },
  { path: "agents/piece-auditor.md", content: "---\nname: piece-auditor\n---\nAudit one piece.\n" },
  { path: "skills/write-skill/SKILL.md", content: "---\nname: write-skill\n---\nWrite a skill.\n" },
];

const writeTree = async (root: string, files: readonly { path: string; content: string }[]) => {
  for (const file of files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.content, "utf8");
  }
};

const readTree = async (root: string) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const tree = await Promise.all(
    files.map(async (path) => ({
      path: path.slice(root.length + 1),
      content: await readFile(path, "utf8"),
    })),
  );
  return tree.sort((a, b) => a.path.localeCompare(b.path));
};

describe("prepareKit", () => {
  let tmp: string;
  let sourceDir: string;
  let home: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fd-kit-copy-"));
    sourceDir = join(tmp, "kit");
    home = join(tmp, "home");
    await writeTree(sourceDir, kitFiles);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("copies the whole tree into the home's kit folder named by its kit version", async () => {
    const version = kitVersion(kitFiles);

    const kit = await prepareKit({ sourceDir, home });

    expect(kit).toEqual({ dir: join(home, "kit", version), version });
    expect(await readTree(kit.dir)).toEqual(await readTree(sourceDir));
  });

  it("leaves a folder already there for that version untouched", async () => {
    const first = await prepareKit({ sourceDir, home });
    expect(first.dir).toBe(join(home, "kit", first.version));
    await writeFile(join(first.dir, "skills/write-skill/SKILL.md"), "edited in place\n", "utf8");
    await writeFile(join(first.dir, "extra.md"), "added in place\n", "utf8");
    const before = await readTree(first.dir);

    const second = await prepareKit({ sourceDir, home });

    expect(second).toEqual(first);
    expect(await readTree(second.dir)).toEqual(before);
  });

  it("puts a changed kit in a new folder and keeps the old one", async () => {
    const first = await prepareKit({ sourceDir, home });
    expect(first.dir).toBe(join(home, "kit", first.version));
    const changed = kitFiles.map((file) =>
      file.path === "skills/write-skill/SKILL.md"
        ? { ...file, content: `${file.content}One more line.\n` }
        : file,
    );
    await writeTree(sourceDir, changed);

    const second = await prepareKit({ sourceDir, home });

    expect(second.version).toBe(kitVersion(changed));
    expect(second.version).not.toBe(first.version);
    expect(second.dir).toBe(join(home, "kit", second.version));
    expect(await readTree(second.dir)).toEqual(await readTree(sourceDir));
    expect(await readTree(first.dir)).toEqual(
      [...kitFiles].sort((a, b) => a.path.localeCompare(b.path)),
    );
    expect((await readdir(join(home, "kit"))).sort()).toEqual(
      [first.version, second.version].sort(),
    );
  });
});
