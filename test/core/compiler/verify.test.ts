import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { build, type BuildDeps, type BuildResult } from "../../../src/core/compiler/build.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { hashBuild, sha256Hex } from "../../../src/core/compiler/hash.js";
import { verify, type VerifyFileSystem } from "../../../src/core/compiler/verify.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { agent, flow, prompt, thenWire } from "../../fixtures/flow-builders.js";

const home = "/fd-home";
const sample = () => flow([prompt("p"), agent("a")], [thenWire("p", "a")]);
const workspace: BuildDeps["workspace"] = {
  id: "b1111111-0000-4000-8000-000000000001",
  name: "fix-login",
  repo: "/work/carousell-web",
  base: "main",
  values: {},
};
const otherHash = "0".repeat(64);

const succeeded = (result: BuildResult) => {
  if (!result.ok) throw new Error("build failed");
  return result;
};

const built = async () => {
  const fs = new FakeFileSystem();
  const { dir, hash } = succeeded(await build(sample(), { fs, home, workspace }));
  return { fs, dir, hash };
};

const copyWithout = async (fs: FakeFileSystem, dir: string, omitted: string) => {
  const copy = new FakeFileSystem();
  for (const path of await fs.list(dir)) {
    if (path !== omitted)
      await copy.writeFile(`${dir}/${path}`, await fs.readFile(`${dir}/${path}`));
  }
  return copy;
};

const legacyFiles = {
  "commands/p.md": '---\ndescription: "p"\n---\nDo the work.\n',
  "agents/a.md": '---\nname: "a"\n---\nImplement the plan.\n',
  "hooks/hooks.json": canonicalJson({ hooks: {} }),
  "settings.json": canonicalJson({ permissions: { allow: [], defaultMode: "default" } }),
};

const legacyBuild = async () => {
  const manifestWithoutHash = {
    version: 1,
    session: { name: "main", workingFolder: { kind: "worktree", branch: "main" } },
    nodes: [
      { id: "p", type: "prompt", label: "p", settings: {}, file: "commands/p.md" },
      { id: "a", type: "agent", label: "a", settings: {}, file: "agents/a.md" },
    ],
    wires: [],
    files: Object.fromEntries(
      Object.entries(legacyFiles).map(([path, content]) => [path, sha256Hex(content)]),
    ),
  };
  const files = Object.entries(legacyFiles).map(([path, content]) => ({ path, content }));
  const hash = hashBuild([
    ...files,
    { path: "manifest.json", content: canonicalJson(manifestWithoutHash) },
  ]);
  const dir = `${home}/builds/${hash}`;
  const fs = new FakeFileSystem({
    ...Object.fromEntries(files.map(({ path, content }) => [`${dir}/${path}`, content])),
    [`${dir}/manifest.json`]: canonicalJson({ ...manifestWithoutHash, hash }),
  });
  return { fs, dir, hash };
};

const enoent = () =>
  Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" }) as Error;

const failingList = (error: Error): VerifyFileSystem => ({
  list: async () => {
    throw error;
  },
  readFile: async () => "",
});

describe("verify", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  describe("a workspace", () => {
    it("accepts a fresh build with work in its worktree on the real file system adapter", async () => {
      tmp = await mkdtemp(join(tmpdir(), "fd-verify-"));
      const fs = new NodeFileSystem() satisfies VerifyFileSystem;
      const { dir, hash } = succeeded(await build(sample(), { fs, home: tmp, workspace }));
      await mkdir(join(dir, "carousell-web", "src"), { recursive: true });
      await writeFile(join(dir, "carousell-web", "src", "login.ts"), "export {};\n");

      expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({ ok: true });
    });

    it("accepts a fresh build, checked against the hash it is given, not its folder name", async () => {
      const { fs, dir, hash } = await built();

      expect(dir.endsWith(hash)).toBe(false);
      expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({ ok: true });
    });

    it("accepts new files inside the worktree folder", async () => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/carousell-web/README.md`, "changed by the run");
      await fs.writeFile(`${dir}/carousell-web/.git/HEAD`, "ref: refs/heads/flowdeck/b1111111");
      await fs.writeFile(`${dir}/carousell-web/plugin/agents/a.md`, "a repo file named like ours");

      expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({ ok: true });
    });

    describe("with build-report.json at its root", () => {
      it("accepts the report the build laid down", async () => {
        const { fs, dir, hash } = await built();

        expect(await fs.readFile(`${dir}/build-report.json`)).not.toBe("");
        expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({ ok: true });
      });

      it("accepts the report after the agents rewrote it", async () => {
        const { fs, dir, hash } = await built();
        await fs.writeFile(`${dir}/build-report.json`, '{"questions":["written after the lock"]}');

        expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({ ok: true });
      });

      it("still names CLAUDE.md when it was edited after the lock", async () => {
        const { fs, dir, hash } = await built();
        await fs.writeFile(`${dir}/build-report.json`, '{"questions":["written after the lock"]}');
        await fs.writeFile(`${dir}/CLAUDE.md`, "tampered");

        expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({
          ok: false,
          problems: [{ path: "CLAUDE.md", problem: "changed" }],
        });
      });
    });

    it.each([
      "plugin/skills/p/SKILL.md",
      "plugin/.claude-plugin/plugin.json",
      "settings.json",
      "CLAUDE.md",
    ])("names %s when it was edited", async (path) => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/${path}`, "tampered");

      expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path, problem: "changed" }],
      });
    });

    it("names the manifest when it was edited but every file still matches", async () => {
      const { fs, dir, hash } = await built();
      const manifest = JSON.parse(await fs.readFile(`${dir}/manifest.json`));
      await fs.writeFile(
        `${dir}/manifest.json`,
        JSON.stringify({ ...manifest, values: { ticket: "FD-1" } }),
      );

      expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "changed" }],
      });
    });

    it("names a plugin file that was deleted", async () => {
      const { fs, dir, hash } = await built();
      const copy = await copyWithout(fs, dir, "plugin/agents/a.md");

      expect(await verify(dir, hash, "workspace", { fs: copy })).toStrictEqual({
        ok: false,
        problems: [{ path: "plugin/agents/a.md", problem: "missing" }],
      });
    });

    it("names a file added to the plugin", async () => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/plugin/agents/stray.md`, "---\nname: stray\n---\n");

      expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "plugin/agents/stray.md", problem: "extra" }],
      });
    });

    it("reports every problem at once, sorted by path", async () => {
      const { fs, dir, hash } = await built();
      const copy = await copyWithout(fs, dir, "plugin/agents/a.md");
      await copy.writeFile(`${dir}/settings.json`, "tampered");
      await copy.writeFile(`${dir}/plugin/skills/extra/SKILL.md`, "stray");

      expect(await verify(dir, hash, "workspace", { fs: copy })).toStrictEqual({
        ok: false,
        problems: [
          { path: "plugin/agents/a.md", problem: "missing" },
          { path: "plugin/skills/extra/SKILL.md", problem: "extra" },
          { path: "settings.json", problem: "changed" },
        ],
      });
    });

    it("names the manifest when the build's row records another hash", async () => {
      const { fs, dir } = await built();

      expect(await verify(dir, otherHash, "workspace", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "changed" }],
      });
    });

    it("names the manifest when it cannot be parsed", async () => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/manifest.json`, "{ not json");

      expect(await verify(dir, hash, "workspace", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "changed" }],
      });
    });

    it("names the manifest when it is gone", async () => {
      const { fs, dir, hash } = await built();
      const copy = await copyWithout(fs, dir, "manifest.json");

      expect(await verify(dir, hash, "workspace", { fs: copy })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "missing" }],
      });
    });

    it("names the manifest as missing when the workspace does not exist", async () => {
      expect(
        await verify(`${home}/workspaces/gone`, otherHash, "workspace", {
          fs: failingList(enoent()),
        }),
      ).toStrictEqual({ ok: false, problems: [{ path: "manifest.json", problem: "missing" }] });
    });

    it("rethrows any other error from listing the folder", async () => {
      const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

      await expect(
        verify(`${home}/workspaces/x`, otherHash, "workspace", { fs: failingList(error) }),
      ).rejects.toBe(error);
    });
  });

  describe("an old flat build in builds/<hash>", () => {
    it("verifies by the old rule", async () => {
      const { fs, dir, hash } = await legacyBuild();

      expect(await verify(dir, hash, "legacy", { fs })).toStrictEqual({ ok: true });
    });

    it("still names any file the build did not write", async () => {
      const { fs, dir, hash } = await legacyBuild();
      await fs.writeFile(`${dir}/notes/.DS_Store`, "");

      expect(await verify(dir, hash, "legacy", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "notes/.DS_Store", problem: "extra" }],
      });
    });

    it("names a generated file that was edited", async () => {
      const { fs, dir, hash } = await legacyBuild();
      await fs.writeFile(`${dir}/commands/p.md`, "tampered");

      expect(await verify(dir, hash, "legacy", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "commands/p.md", problem: "changed" }],
      });
    });

    it("names the manifest when the row records another hash", async () => {
      const { fs, dir } = await legacyBuild();

      expect(await verify(dir, otherHash, "legacy", { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "changed" }],
      });
    });
  });
});
