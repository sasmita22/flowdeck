import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { deleteBuild, deleteBuildResultSchema } from "../../../src/core/run/delete-build.js";
import type { NewBuild, NewRun } from "../../../src/ports/store.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const run = promisify(execFile);

const committer = [
  "-c",
  "user.name=Flowdeck Test",
  "-c",
  "user.email=test@flowdeck.invalid",
  "-c",
  "commit.gpgsign=false",
];

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args]);
  return stdout;
}

const branches = async (repo: string): Promise<string[]> =>
  (await git(repo, "branch", "--list", "--format=%(refname:short)")).split("\n").filter(Boolean);

const worktreePaths = async (repo: string): Promise<string[]> =>
  (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const buildId = "0f3a9c2e-1111-2222-3333-444455556666";
const branch = "flowdeck/fix-login-0f3a9c2e";

const namedBuild = (home: string, repo: string, id = buildId): NewBuild => ({
  id,
  hash: "abc",
  name: "fix-login",
  repo,
  base: "main",
  values: { ticket: "FD-1" },
  dir: `${home}/workspaces/${id}`,
  files: [],
  nodes: [{ nodeId: "s1", type: "script", config: {} }],
});

const runOf = (build: { id: string; dir: string }): NewRun => ({
  buildDir: build.dir,
  inputs: {},
  nodeIds: ["s1"],
  session: { tmuxName: "fd-run", cwd: build.dir, claudeSessionId: "c1" },
  buildId: build.id,
});

describe("deleteBuild", () => {
  describe("while the build has a running run", () => {
    it("refuses, removing and marking nothing", async () => {
      const home = "/fd-home";
      const store = new FakeStore();
      const fs = new FakeFileSystem({ [`${home}/workspaces/${buildId}/CLAUDE.md`]: "# fix-login" });
      const worktree = new FakeWorktree();
      const build = namedBuild(home, "/work/carousell-web");
      store.recordBuild(build);
      store.createRun(runOf(build));

      const result = await deleteBuild({ store, worktree, fs, home }, buildId);

      expect(result.ok).toBe(false);
      expect(store.findBuild(buildId)?.deletedAt).toBeNull();
      expect(store.listBuilds().map((known) => known.id)).toEqual([buildId]);
      expect(
        fs.calls.filter((call) => call.method === "remove" || call.method === "removeTree"),
      ).toEqual([]);
      expect(worktree.removed).toEqual([]);
      expect(worktree.deletedBranches).toEqual([]);
    });
  });

  describe("on real git, SQLite and files", () => {
    let repo: TmpRepo;
    let home: string;
    let elsewhere: string;
    let db: Database.Database;
    let store: SqliteStore;
    const fs = new NodeFileSystem();
    const worktree = new GitWorktree();

    beforeEach(async () => {
      repo = await createTmpRepo({ commit: true });
      home = await realpath(await mkdtemp(join(tmpdir(), "fd-delete-home-")));
      elsewhere = `${home}-elsewhere`;
      await mkdir(elsewhere);
      db = openDatabase({ path: join(home, "flowdeck.db") });
      store = new SqliteStore({ db });
    });

    afterEach(async () => {
      db.close();
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    });

    const makeBuild = async () => {
      const build = namedBuild(home, repo.path);
      const worktreePath = join(build.dir, basename(repo.path));
      await fs.writeFile(join(build.dir, "CLAUDE.md"), "# fix-login\n");
      await fs.writeFile(join(build.dir, "manifest.json"), "{}\n");
      await fs.writeFile(join(build.dir, "plugin", "commands", "p1.md"), "Fix FD-1\n");
      await worktree.add({ repo: repo.path, base: "main", branch, path: worktreePath });
      store.recordBuild(build);
      const finished = store.createRun(runOf(build));
      store.finishRun(finished.id, "done");
      return { build, worktreePath, runId: finished.id };
    };

    const expectMarkedDeleted = (runId: string) => {
      expect(store.findBuild(buildId)?.deletedAt).not.toBeNull();
      expect(store.listBuilds().map((known) => known.id)).not.toContain(buildId);
      expect(store.listRuns().map((known) => known.id)).not.toContain(runId);
      expect(store.findBuildByName("fix-login")).toBeUndefined();
    };

    it("removes a clean build's workspace and branch, marks it deleted, hides its runs and frees its name", async () => {
      const { build, worktreePath, runId } = await makeBuild();

      const result = await deleteBuild({ store, worktree, fs, home }, buildId);

      expect(result).toEqual({ ok: true });
      expect(await exists(build.dir)).toBe(false);
      expect(await worktreePaths(repo.path)).not.toContain(worktreePath);
      expect(await branches(repo.path)).not.toContain(branch);
      expectMarkedDeleted(runId);
      expect(() =>
        store.recordBuild({ ...namedBuild(home, repo.path, "second-id"), name: "fix-login" }),
      ).not.toThrow();
    });

    it.each([
      [
        "uncommitted",
        async (path: string) => {
          await writeFile(join(path, "notes.txt"), "work in progress\n");
        },
      ],
      [
        "committed but unpushed",
        async (path: string) => {
          await writeFile(join(path, "notes.txt"), "work in progress\n");
          await git(path, "add", "notes.txt");
          await git(path, ...committer, "commit", "--quiet", "-m", "wip");
        },
      ],
    ])(
      "keeps a worktree holding %s work with its branch, removes the rest and returns the kept path",
      async (_label, work) => {
        const { build, worktreePath, runId } = await makeBuild();
        await work(worktreePath);

        const result = await deleteBuild({ store, worktree, fs, home }, buildId);

        expect(result).toEqual({ ok: true, kept: { kind: "worktree", path: worktreePath } });
        expect(await readFile(join(worktreePath, "notes.txt"), "utf8")).toBe("work in progress\n");
        expect(await branches(repo.path)).toContain(branch);
        expect(await exists(join(build.dir, "CLAUDE.md"))).toBe(false);
        expect(await exists(join(build.dir, "manifest.json"))).toBe(false);
        expect(await exists(join(build.dir, "plugin"))).toBe(false);
        expectMarkedDeleted(runId);
      },
    );

    it("keeps a branch holding commits whose worktree folder is gone, and says the branch was kept", async () => {
      const { build, worktreePath, runId } = await makeBuild();
      await writeFile(join(worktreePath, "notes.txt"), "work in progress\n");
      await git(worktreePath, "add", "notes.txt");
      await git(worktreePath, ...committer, "commit", "--quiet", "-m", "wip");
      await rm(worktreePath, { recursive: true, force: true });

      const result = await deleteBuild({ store, worktree, fs, home }, buildId);

      expect(result).toEqual({ ok: true, kept: { kind: "branch", branch } });
      expect(await branches(repo.path)).toContain(branch);
      expect(await exists(build.dir)).toBe(false);
      expectMarkedDeleted(runId);
    });

    const recordOldBuild = (hash: string, dir: string) => {
      db.prepare("INSERT INTO builds (id, hash, dir, created_at) VALUES (?, ?, ?, ?)").run(
        hash,
        hash,
        dir,
        1,
      );
    };

    it("removes an old hash build's folder that sits under $FLOWDECK_HOME", async () => {
      const dir = join(home, "builds", "oldhash1");
      await mkdir(join(dir, "commands"), { recursive: true });
      await writeFile(join(dir, "manifest.json"), "{}\n");
      recordOldBuild("oldhash1", dir);

      const result = await deleteBuild({ store, worktree, fs, home }, "oldhash1");

      expect(result).toEqual({ ok: true });
      expect(await exists(dir)).toBe(false);
      expect(store.findBuild("oldhash1")?.deletedAt).not.toBeNull();
      expect(store.listBuilds().map((known) => known.id)).not.toContain("oldhash1");
    });

    it("leaves an old hash build's folder outside $FLOWDECK_HOME, even one beside it, and returns it", async () => {
      const dir = join(elsewhere, "oldhash2");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.json"), "{}\n");
      recordOldBuild("oldhash2", dir);

      const result = await deleteBuild({ store, worktree, fs, home }, "oldhash2");

      expect(result).toEqual({ ok: true, kept: { kind: "folder", path: dir } });
      expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe("{}\n");
      expect(store.findBuild("oldhash2")?.deletedAt).not.toBeNull();
    });
  });
});

describe("deleteBuildResultSchema", () => {
  it("reads each kept kind, a plain delete and a refusal", () => {
    const results = [
      { ok: true },
      { ok: true, kept: { kind: "worktree", path: "/w" } },
      { ok: true, kept: { kind: "branch", branch: "flowdeck/b" } },
      { ok: true, kept: { kind: "folder", path: "/f" } },
      { ok: false, message: "no" },
    ];

    expect(results.map((result) => deleteBuildResultSchema.parse(result))).toEqual(results);
  });

  it("rejects a kept thing of an unknown kind", () => {
    expect(
      deleteBuildResultSchema.safeParse({ ok: true, kept: { kind: "tag", path: "/t" } }).success,
    ).toBe(false);
  });
});
