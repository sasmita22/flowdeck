import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import {
  build,
  type BuildDeps,
  type BuildFileSystem,
  type BuildResult,
} from "../../../src/core/compiler/build.js";
import { hashBuild } from "../../../src/core/compiler/hash.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { agent, onMainFlow, prompt, thenWire } from "../../fixtures/flow-builders.js";

const home = "/fd-home";
const expectedFiles = [
  "CLAUDE.md",
  "build-report.json",
  "manifest.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/agents/a.md",
  "plugin/hooks/hooks.json",
  "plugin/hooks/no-force-push.sh",
  "plugin/hooks/rules-after-compact.sh",
  "plugin/skills/p/SKILL.md",
  "plugin/skills/run/SKILL.md",
  "settings.json",
];

const reportPath = "build-report.json";

type Workspace = BuildDeps["workspace"];

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: "b1111111-0000-4000-8000-000000000001",
  name: "fix-login",
  repo: "/work/carousell-web",
  base: "main",
  values: {},
  blueprint: { name: "Bugfix", version: 3 },
  ...overrides,
});

const sample = (instructions = "Do the work."): Flow => {
  const base = onMainFlow(
    [prompt("p", { settings: { instructions } }), agent("a", { settings: { tools: ["Grep"] } })],
    [thenWire("p", "a")],
  );
  return { ...base, session: { ...base.session, allowedTools: ["Read", "Edit", "Grep"] } };
};

const run = (fs: FakeFileSystem, input: Flow = sample(), named: Workspace = workspace()) =>
  build(input, { fs, home, workspace: named });

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

const hashed = async (fs: FakeFileSystem, dir: string) =>
  (await readBack(fs, dir)).filter(({ path }) => path !== reportPath);

const writes = (fs: FakeFileSystem) =>
  fs.calls.filter((call) => call.method === "writeFile").map((call) => call.path);

describe("build", () => {
  it("takes the real file system adapter", () => {
    expect(new NodeFileSystem() satisfies BuildFileSystem).toBeInstanceOf(NodeFileSystem);
  });

  it("writes exactly the workspace files into workspaces/<build id>, allowing only the session's tools", async () => {
    const fs = new FakeFileSystem();

    const result = succeeded(await run(fs));

    expect(result.dir).toBe(`/fd-home/workspaces/${workspace().id}`);
    expect(await fs.list(result.dir)).toEqual(expectedFiles);
    const settings = JSON.parse(await fs.readFile(`${result.dir}/settings.json`));
    expect(settings.permissions.allow).toEqual(["Read", "Edit", "Grep"]);
  });

  it("writes the manifest last, recording a hash the written files but the report reproduce", async () => {
    const fs = new FakeFileSystem();

    const result = succeeded(await run(fs));

    expect(writes(fs).at(-1)).toBe(`${result.dir}/manifest.json`);
    const manifest = JSON.parse(await fs.readFile(`${result.dir}/manifest.json`));
    expect(manifest.hash).toBe(result.hash);
    expect(hashBuild(await hashed(fs, result.dir))).toBe(result.hash);
  });

  it("records a sha256 of every other written file but the report in the manifest", async () => {
    const fs = new FakeFileSystem();

    const { dir } = succeeded(await run(fs));

    const manifest = JSON.parse(await fs.readFile(`${dir}/manifest.json`));
    const expected = Object.fromEntries(
      (await hashed(fs, dir))
        .filter(({ path }) => path !== "manifest.json")
        .map(({ path, content }) => [path, createHash("sha256").update(content).digest("hex")]),
    );
    expect(manifest.files).toStrictEqual(expected);
  });

  it("builds one version under two names into two folders with two hashes", async () => {
    const fs = new FakeFileSystem();
    const source = { flowId: "f1", version: 1 };

    const login = succeeded(
      await build(sample(), {
        fs,
        home,
        source,
        workspace: workspace({ id: "b-1", name: "fix-login" }),
      }),
    );
    const signup = succeeded(
      await build(sample(), {
        fs,
        home,
        source,
        workspace: workspace({ id: "b-2", name: "fix-signup" }),
      }),
    );

    expect(signup.hash).not.toBe(login.hash);
    expect(signup.dir).not.toBe(login.dir);
    expect(await fs.list(login.dir)).toEqual(expectedFiles);
    expect(await fs.list(signup.dir)).toEqual(expectedFiles);
    const pluginName = async (dir: string) =>
      JSON.parse(await fs.readFile(`${dir}/plugin/.claude-plugin/plugin.json`)).name;
    expect(await pluginName(login.dir)).toBe("fix-login");
    expect(await pluginName(signup.dir)).toBe("fix-signup");
  });

  it("covers CLAUDE.md in the hash, so a build from another base has another hash", async () => {
    const onMain = succeeded(
      await run(new FakeFileSystem(), sample(), workspace({ base: "main" })),
    );
    const onRelease = succeeded(
      await run(new FakeFileSystem(), sample(), workspace({ base: "release" })),
    );

    expect(onRelease.hash).not.toBe(onMain.hash);
  });

  it("writes every build afresh and never looks in builds/<hash>", async () => {
    const fs = new FakeFileSystem();
    const first = succeeded(await run(fs, sample(), workspace({ id: "b-1" })));
    const writesAfterFirst = writes(fs).length;

    const second = succeeded(await run(fs, sample(), workspace({ id: "b-1" })));

    expect(second.hash).toBe(first.hash);
    expect(writes(fs).slice(writesAfterFirst).sort()).toEqual(
      expectedFiles.map((path) => `${second.dir}/${path}`),
    );
    expect(fs.calls.filter((call) => call.path.startsWith(`${home}/builds/`))).toEqual([]);
    expect(second).not.toHaveProperty("reused");
  });

  it("builds the same bytes in two homes once the workspace folder is set aside, naming the home nowhere else", async () => {
    const first = new FakeFileSystem();
    const second = new FakeFileSystem();

    const a = succeeded(
      await build(sample(), { fs: first, home: "/Users/a/.flowdeck", workspace: workspace() }),
    );
    const b = succeeded(
      await build(sample(), { fs: second, home: "/tmp/other home", workspace: workspace() }),
    );

    const outsideWorkspace = async (fs: FakeFileSystem, dir: string) =>
      (await readBack(fs, dir)).map(({ path, content }) => ({
        path,
        content: content.replaceAll(dir, "<workspace>"),
      }));
    const files = await outsideWorkspace(first, a.dir);
    const notManifest = ({ path }: { path: string }) => path !== "manifest.json";
    expect((await outsideWorkspace(second, b.dir)).filter(notManifest)).toEqual(
      files.filter(notManifest),
    );
    for (const { content } of [...files, ...(await outsideWorkspace(second, b.dir))]) {
      expect(content).not.toContain("/Users/a");
      expect(content).not.toContain("/tmp/other home");
      expect(content).not.toContain("flowdeck-hook");
    }
  });

  it("returns its record: every written file with the sha256 of its bytes, and every manifest node", async () => {
    const fs = new FakeFileSystem();

    const result = succeeded(await run(fs));

    const onDisk = await hashed(fs, result.dir);
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
    expect(result.record.nodes.map((node) => node.nodeId)).toEqual(["start", "p", "a", "stop"]);
  });

  it("names the saved flow version it was built from, so each version has its own hash", async () => {
    const v1 = { flowId: "f1", version: 1 };
    const named = workspace();
    const build1 = succeeded(
      await build(sample(), { fs: new FakeFileSystem(), home, source: v1, workspace: named }),
    );
    const again = succeeded(
      await build(sample(), { fs: new FakeFileSystem(), home, source: v1, workspace: named }),
    );
    const build2 = succeeded(
      await build(sample(), {
        fs: new FakeFileSystem(),
        home,
        source: { flowId: "f1", version: 2 },
        workspace: named,
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
