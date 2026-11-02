import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { build, type BuildFileSystem, type BuildResult } from "../../../src/core/compiler/build.js";
import { hashBuild } from "../../../src/core/compiler/hash.js";
import { verify } from "../../../src/core/compiler/verify.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { agent, flow, prompt, thenWire } from "../../fixtures/flow-builders.js";

const home = "/fd-home";
const expectedFiles = [
  "agents/a.md",
  "commands/p.md",
  "hooks/hooks.json",
  "manifest.json",
  "settings.json",
];

const sample = (instructions = "Do the work."): Flow => {
  const base = flow(
    [prompt("p", { settings: { instructions } }), agent("a", { settings: { tools: ["Grep"] } })],
    [thenWire("p", "a")],
  );
  return { ...base, session: { ...base.session, allowedTools: ["Read", "Edit"] } };
};

const run = (fs: FakeFileSystem, input: Flow = sample()) => build(input, { fs, home });

const succeeded = (result: BuildResult) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("build failed");
  return result;
};

const readBack = async (fs: FakeFileSystem, dir: string) =>
  Promise.all(
    (await fs.list(dir)).map(async (path) => ({
      path,
      content: await fs.readFile(`${dir}/${path}`),
    })),
  );

const writes = (fs: FakeFileSystem) =>
  fs.calls.filter((call) => call.method === "writeFile").map((call) => call.path);

describe("build", () => {
  it("takes the real file system adapter", () => {
    expect(new NodeFileSystem() satisfies BuildFileSystem).toBeInstanceOf(NodeFileSystem);
  });

  it("writes exactly the build files into builds/<hash>, allowing only the session's tools", async () => {
    const fs = new FakeFileSystem();

    const result = succeeded(await run(fs));

    expect(result.reused).toBe(false);
    expect(result.dir).toBe(`/fd-home/builds/${result.hash}`);
    expect(await fs.list(result.dir)).toEqual(expectedFiles);
    const settings = JSON.parse(await fs.readFile(`${result.dir}/settings.json`));
    expect(settings.permissions.allow).toEqual(["Read", "Edit"]);
  });

  it("writes the manifest last, recording a hash the written files reproduce", async () => {
    const fs = new FakeFileSystem();

    const result = succeeded(await run(fs));

    expect(writes(fs).at(-1)).toBe(`${result.dir}/manifest.json`);
    const manifest = JSON.parse(await fs.readFile(`${result.dir}/manifest.json`));
    expect(manifest.hash).toBe(result.hash);
    expect(hashBuild(await readBack(fs, result.dir))).toBe(result.hash);
  });

  it("records a sha256 of every other written file in the manifest", async () => {
    const fs = new FakeFileSystem();

    const { dir } = succeeded(await run(fs));

    const manifest = JSON.parse(await fs.readFile(`${dir}/manifest.json`));
    const expected = Object.fromEntries(
      (await readBack(fs, dir))
        .filter(({ path }) => path !== "manifest.json")
        .map(({ path, content }) => [path, createHash("sha256").update(content).digest("hex")]),
    );
    expect(manifest.files).toStrictEqual(expected);
  });

  it("reuses the folder for the same flow without writing again", async () => {
    const fs = new FakeFileSystem();
    const first = succeeded(await run(fs));
    const writesAfterFirst = writes(fs).length;

    const second = succeeded(await run(fs));

    expect(second).toStrictEqual({ ...first, reused: true });
    expect(writes(fs)).toHaveLength(writesAfterFirst);
  });

  it("builds the same hash and bytes in two homes, naming neither", async () => {
    const first = new FakeFileSystem();
    const second = new FakeFileSystem();

    const a = succeeded(await build(sample(), { fs: first, home: "/Users/a/.flowdeck" }));
    const b = succeeded(await build(sample(), { fs: second, home: "/tmp/other home" }));

    expect(b.hash).toBe(a.hash);
    const files = await readBack(first, a.dir);
    expect(await readBack(second, b.dir)).toEqual(files);
    for (const { content } of files) {
      expect(content).not.toContain("/Users/a");
      expect(content).not.toContain("flowdeck-hook");
    }
  });

  it("returns its record: every written file with the sha256 of its bytes, and every manifest node", async () => {
    const fs = new FakeFileSystem();

    const result = succeeded(await run(fs));

    const onDisk = await readBack(fs, result.dir);
    expect(result.record.files).toEqual(
      onDisk.map(({ path, content }) => ({
        path,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    );
    const manifest = JSON.parse(await fs.readFile(`${result.dir}/manifest.json`));
    expect(result.record).toMatchObject({ hash: result.hash, dir: result.dir });
    expect(result.record).not.toHaveProperty("source");
    expect(result.record.nodes).toEqual(
      manifest.nodes.map(
        (node: { id: string; type: string; settings: unknown; file?: string }) => ({
          nodeId: node.id,
          type: node.type,
          config: node.settings,
          ...(node.file === undefined ? {} : { file: node.file }),
        }),
      ),
    );
    expect(result.record.nodes.map((node) => node.nodeId)).toEqual(["p", "a"]);
  });

  it("returns the same record when it reuses the folder", async () => {
    const fs = new FakeFileSystem();
    const first = succeeded(await run(fs));

    const second = succeeded(await run(fs));

    expect(second.record).toEqual(first.record);
  });

  it("names the saved flow version it was built from, so each version has its own hash", async () => {
    const v1 = { flowId: "f1", version: 1 };
    const build1 = succeeded(await build(sample(), { fs: new FakeFileSystem(), home, source: v1 }));
    const again = succeeded(await build(sample(), { fs: new FakeFileSystem(), home, source: v1 }));
    const build2 = succeeded(
      await build(sample(), {
        fs: new FakeFileSystem(),
        home,
        source: { flowId: "f1", version: 2 },
      }),
    );

    expect(again.hash).toBe(build1.hash);
    expect(build2.hash).not.toBe(build1.hash);
    expect(build1.record.source).toEqual(v1);
  });

  it("gives a different hash when one character of a prompt changes", async () => {
    const before = succeeded(await run(new FakeFileSystem(), sample("Do the work.")));
    const after = succeeded(await run(new FakeFileSystem(), sample("Do the work!")));

    expect(after.hash).not.toBe(before.hash);
  });

  it("refuses a broken flow without touching the file system", async () => {
    const broken = parseFlow(
      JSON.parse(
        readFileSync(new URL("../../fixtures/broken/node-ids.json", import.meta.url), "utf8"),
      ),
    );
    const fs = new FakeFileSystem();

    const result = await run(fs, broken);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).not.toEqual([]);
    expect(fs.calls).toEqual([]);
  });

  it("restores a tampered cached build to its recorded bytes, and says what it restored", async () => {
    const fs = new FakeFileSystem();
    const first = succeeded(await run(fs));
    const original = await readBack(fs, first.dir);
    await fs.writeFile(`${first.dir}/commands/p.md`, "tampered");
    await fs.remove(`${first.dir}/agents/a.md`);
    await fs.writeFile(`${first.dir}/.DS_Store`, "finder");

    const second = succeeded(await run(fs));

    expect(second).toMatchObject({ hash: first.hash, dir: first.dir, reused: true });
    expect(second.restored).toEqual([
      { path: ".DS_Store", problem: "extra" },
      { path: "agents/a.md", problem: "missing" },
      { path: "commands/p.md", problem: "changed" },
    ]);
    expect(await readBack(fs, first.dir)).toEqual(original);
    expect(await verify(first.dir, { fs })).toEqual({ ok: true });
  });

  it("restores a file edited together with its sha in the manifest", async () => {
    const fs = new FakeFileSystem();
    const first = succeeded(await run(fs));
    const original = await readBack(fs, first.dir);
    const manifest = JSON.parse(await fs.readFile(`${first.dir}/manifest.json`));
    manifest.files["commands/p.md"] = createHash("sha256").update("forged").digest("hex");
    await fs.writeFile(`${first.dir}/commands/p.md`, "forged");
    await fs.writeFile(`${first.dir}/manifest.json`, JSON.stringify(manifest));

    const second = succeeded(await run(fs));

    expect(second).toMatchObject({ hash: first.hash, reused: true });
    expect(await readBack(fs, first.dir)).toEqual(original);
    expect(await verify(first.dir, { fs })).toEqual({ ok: true });
  });

  it("restores nothing and writes nothing when the cached build is intact", async () => {
    const fs = new FakeFileSystem();
    succeeded(await run(fs));
    const writesBefore = writes(fs).length;

    const again = succeeded(await run(fs));

    expect(again.restored).toEqual([]);
    expect(writes(fs)).toHaveLength(writesBefore);
    expect(fs.calls.some((call) => call.method === "remove")).toBe(false);
  });

  it("rebuilds a folder that has no manifest", async () => {
    const { dir } = succeeded(await run(new FakeFileSystem()));
    const fs = new FakeFileSystem({ [`${dir}/commands/p.md`]: "half written" });

    const result = succeeded(await run(fs));

    expect(result.reused).toBe(false);
    expect(writes(fs).sort()).toEqual(expectedFiles.map((path) => `${dir}/${path}`));
  });

  it("writes the same bytes as the recorded build", async () => {
    const fs = new FakeFileSystem();
    const { dir } = succeeded(await run(fs));

    const files = Object.fromEntries(
      (await readBack(fs, dir)).map(({ path, content }) => [path, content]),
    );

    expect(files).toMatchSnapshot();
  });

  it("builds a flow with notes into the same hash and the same bytes as the flow without them", async () => {
    const plain = sample();
    const noted = parseFlow({
      ...plain,
      notes: [
        {
          id: "n1",
          text: "Plan first",
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
        },
        {
          id: "p",
          text: "same id as a node",
          position: { x: 9, y: 9 },
          size: { width: 1, height: 1 },
        },
      ],
    });
    expect(noted.notes).toHaveLength(2);
    const plainFs = new FakeFileSystem();
    const notedFs = new FakeFileSystem();

    const without = succeeded(await run(plainFs, plain));
    const withNotes = succeeded(await run(notedFs, noted));

    expect(withNotes.hash).toBe(without.hash);
    expect(await readBack(notedFs, withNotes.dir)).toEqual(await readBack(plainFs, without.dir));
  });
});
