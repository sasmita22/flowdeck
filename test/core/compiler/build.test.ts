import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { build, type BuildFileSystem, type BuildResult } from "../../../src/core/compiler/build.js";
import { hashBuild } from "../../../src/core/compiler/hash.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { agent, flow, prompt, thenWire } from "../../fixtures/flow-builders.js";

const home = "/fd-home";
const hooks = { nodePath: "/usr/local/bin/node", hookScriptPath: "/fd/bin/flowdeck-hook.mjs" };
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

const run = (fs: FakeFileSystem, input: Flow = sample()) => build(input, { fs, home, hooks });

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

  it("reuses the folder for the same flow without writing again", async () => {
    const fs = new FakeFileSystem();
    const first = succeeded(await run(fs));
    const writesAfterFirst = writes(fs).length;

    const second = succeeded(await run(fs));

    expect(second).toStrictEqual({ ...first, reused: true });
    expect(writes(fs)).toHaveLength(writesAfterFirst);
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
});
