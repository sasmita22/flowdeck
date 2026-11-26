import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import type { BuildDeps, BuildResult } from "../../../src/core/compiler/build.js";
import {
  verify,
  workspaceListing,
  workspaceRootFiles,
  type VerifyFileSystem,
} from "../../../src/core/compiler/verify.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { build } from "../../fixtures/build.js";
import { agent, onMainFlow, thenWire } from "../../fixtures/flow-builders.js";

const home = "/fd-home";
const sample = () => onMainFlow([agent("p"), agent("a")], [thenWire("p", "a")]);
const workspace: BuildDeps["workspace"] = {
  id: "b1111111-0000-4000-8000-000000000001",
  name: "fix-login",
  repo: "/work/carousell-web",
  base: "main",
  branch: "flowdeck/fix-login",
  branchCreated: true,
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

const enoent = () =>
  Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" }) as Error;

const failingList = (error: Error): VerifyFileSystem => ({
  list: async () => {
    throw error;
  },
  folders: async () => [],
  readFile: async () => "",
});

describe("workspaceListing", () => {
  it("lists the plugin and the named root files that exist, never the repository folder", async () => {
    const { fs, dir } = await built();
    await fs.writeFile(`${dir}/sessions/main/repo/README.md`, "a repo file");
    await fs.writeFile(
      `${dir}/sessions/main/repo/plugin/agents/a.md`,
      "a repo file named like ours",
    );
    await fs.writeFile(`${dir}/sessions/main/repo/manifest.json`, "{}");
    const plugins = await Promise.all(
      ["workspace", "sessions/main"].map(async (root) =>
        (await fs.list(`${dir}/${root}/plugin`)).map((path) => `${root}/plugin/${path}`),
      ),
    );
    const roots = ["workspace", "sessions/main"].flatMap((root) => [
      `${root}/CLAUDE.md`,
      `${root}/settings.json`,
    ]);

    const listing = await workspaceListing(fs, dir, [
      "manifest.json",
      "build-report.json",
      "absent.json",
    ]);

    expect(plugins.flat().length).toBeGreaterThan(0);
    expect([...(listing?.paths ?? [])].sort()).toStrictEqual(
      ["manifest.json", "build-report.json", ...roots, ...plugins.flat()].sort(),
    );
  });
});

describe("workspaceListing per container", () => {
  const dir = "/fd-home/workspaces/b-two";
  const ours = [
    "manifest.json",
    "workspace/CLAUDE.md",
    "workspace/settings.json",
    "workspace/plugin/.claude-plugin/plugin.json",
    "workspace/plugin/skills/run/SKILL.md",
    "sessions/android/CLAUDE.md",
    "sessions/android/settings.json",
    "sessions/android/plugin/.claude-plugin/plugin.json",
    "sessions/android/plugin/agents/plan.md",
    "sessions/android/plugin/skills/run/SKILL.md",
    "sessions/ios/CLAUDE.md",
    "sessions/ios/settings.json",
    "sessions/ios/plugin/agents/plan.md",
    "sessions/ios/plugin/skills/run/SKILL.md",
  ];
  const repoFiles = [
    "sessions/android/android/README.md",
    "sessions/android/android/CLAUDE.md",
    "sessions/android/android/settings.json",
    "sessions/android/android/plugin/agents/plan.md",
    "sessions/ios/ios/src/App.swift",
  ];

  it("lists the workspace and every session's plugin, settings and CLAUDE.md, never a session's worktree", async () => {
    const fs = new FakeFileSystem(
      Object.fromEntries([...ours, ...repoFiles].map((path) => [`${dir}/${path}`, path])),
    );

    const listing = await workspaceListing(fs, dir, workspaceRootFiles);

    expect([...(listing?.paths ?? [])].sort()).toStrictEqual([...ours].sort());
  });
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
      await mkdir(join(dir, "sessions", "main", "repo", "src"), { recursive: true });
      await writeFile(join(dir, "sessions", "main", "repo", "src", "login.ts"), "export {};\n");

      expect(await verify(dir, hash, { fs })).toStrictEqual({ ok: true });
    });

    it("accepts a fresh build, checked against the hash it is given, not its folder name", async () => {
      const { fs, dir, hash } = await built();

      expect(dir.endsWith(hash)).toBe(false);
      expect(await verify(dir, hash, { fs })).toStrictEqual({ ok: true });
    });

    it("accepts new files inside the worktree folder", async () => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/sessions/main/repo/README.md`, "changed by the run");
      await fs.writeFile(
        `${dir}/sessions/main/repo/.git/HEAD`,
        "ref: refs/heads/flowdeck/b1111111",
      );
      await fs.writeFile(
        `${dir}/sessions/main/repo/plugin/agents/a.md`,
        "a repo file named like ours",
      );

      expect(await verify(dir, hash, { fs })).toStrictEqual({ ok: true });
    });

    describe("with build-report.json at its root", () => {
      it("accepts the report the build laid down", async () => {
        const { fs, dir, hash } = await built();

        expect(await fs.readFile(`${dir}/build-report.json`)).not.toBe("");
        expect(await verify(dir, hash, { fs })).toStrictEqual({ ok: true });
      });

      it("accepts the report after the agents rewrote it", async () => {
        const { fs, dir, hash } = await built();
        await fs.writeFile(`${dir}/build-report.json`, '{"questions":["written after the lock"]}');

        expect(await verify(dir, hash, { fs })).toStrictEqual({ ok: true });
      });

      it("still names CLAUDE.md when it was edited after the lock", async () => {
        const { fs, dir, hash } = await built();
        await fs.writeFile(`${dir}/build-report.json`, '{"questions":["written after the lock"]}');
        await fs.writeFile(`${dir}/sessions/main/CLAUDE.md`, "tampered");

        expect(await verify(dir, hash, { fs })).toStrictEqual({
          ok: false,
          problems: [{ path: "sessions/main/CLAUDE.md", problem: "changed" }],
        });
      });
    });

    it.each([
      "sessions/main/plugin/agents/p.md",
      "sessions/main/plugin/.claude-plugin/plugin.json",
      "sessions/main/settings.json",
      "sessions/main/CLAUDE.md",
      "workspace/settings.json",
      "workspace/CLAUDE.md",
    ])("names %s when it was edited", async (path) => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/${path}`, "tampered");

      expect(await verify(dir, hash, { fs })).toStrictEqual({
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

      expect(await verify(dir, hash, { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "changed" }],
      });
    });

    it("names a plugin file that was deleted", async () => {
      const { fs, dir, hash } = await built();
      const copy = await copyWithout(fs, dir, "sessions/main/plugin/agents/a.md");

      expect(await verify(dir, hash, { fs: copy })).toStrictEqual({
        ok: false,
        problems: [{ path: "sessions/main/plugin/agents/a.md", problem: "missing" }],
      });
    });

    it("names a file added to the plugin", async () => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/sessions/main/plugin/agents/stray.md`, "---\nname: stray\n---\n");

      expect(await verify(dir, hash, { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "sessions/main/plugin/agents/stray.md", problem: "extra" }],
      });
    });

    it("reports every problem at once, sorted by path", async () => {
      const { fs, dir, hash } = await built();
      const copy = await copyWithout(fs, dir, "sessions/main/plugin/agents/a.md");
      await copy.writeFile(`${dir}/sessions/main/settings.json`, "tampered");
      await copy.writeFile(`${dir}/sessions/main/plugin/skills/extra/SKILL.md`, "stray");

      expect(await verify(dir, hash, { fs: copy })).toStrictEqual({
        ok: false,
        problems: [
          { path: "sessions/main/plugin/agents/a.md", problem: "missing" },
          { path: "sessions/main/plugin/skills/extra/SKILL.md", problem: "extra" },
          { path: "sessions/main/settings.json", problem: "changed" },
        ],
      });
    });

    it("names the manifest when the build's row records another hash", async () => {
      const { fs, dir } = await built();

      expect(await verify(dir, otherHash, { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "changed" }],
      });
    });

    it("names the manifest when it cannot be parsed", async () => {
      const { fs, dir, hash } = await built();
      await fs.writeFile(`${dir}/manifest.json`, "{ not json");

      expect(await verify(dir, hash, { fs })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "changed" }],
      });
    });

    it("names the manifest when it is gone", async () => {
      const { fs, dir, hash } = await built();
      const copy = await copyWithout(fs, dir, "manifest.json");

      expect(await verify(dir, hash, { fs: copy })).toStrictEqual({
        ok: false,
        problems: [{ path: "manifest.json", problem: "missing" }],
      });
    });

    it("names the manifest as missing when the workspace does not exist", async () => {
      expect(
        await verify(`${home}/workspaces/gone`, otherHash, {
          fs: failingList(enoent()),
        }),
      ).toStrictEqual({ ok: false, problems: [{ path: "manifest.json", problem: "missing" }] });
    });

    it("rethrows any other error from listing the folder", async () => {
      const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

      await expect(
        verify(`${home}/workspaces/x`, otherHash, { fs: failingList(error) }),
      ).rejects.toBe(error);
    });
  });
});
