import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import {
  claudeProjectFolder,
  deleteBuild,
  deleteBuildResultSchema,
  deletePreview,
  storedBranch,
  teardownWorkspace,
} from "../../../src/core/run/delete-build.js";
import type { PullRequestState } from "../../../src/ports/pull-requests.js";
import type { BuildRecord, NewBuild, NewRun } from "../../../src/ports/store.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakePullRequests } from "../../fakes/fake-pull-requests.js";
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
  branch,
  branchCreated: true,
  values: { ticket: "FD-1" },
  dir: `${home}/workspaces/${id}`,
  files: [],
  nodes: [{ nodeId: "s1", type: "script", config: {} }],
  manifest: "{}",
});

const runOf = (build: { id: string; dir: string }): NewRun => ({
  buildDir: build.dir,
  inputs: {},
  nodeIds: ["s1"],
  session: { tmuxName: "fd-run", cwd: build.dir, claudeSessionId: "c1" },
  buildId: build.id,
});

describe("deleteBuild", () => {
  const home = "/fd-home";
  const workspace = `${home}/workspaces/${buildId}`;
  const worktreePath = `${workspace}/carousell-web`;
  const sessionFolder = `${home}/build-sessions/fd-build-fix-login`;
  const claudeConfig = {
    projectsDir: "/claude-config/projects",
    claudeJson: "/claude-config/.claude.json",
  };
  const slug = "-fd-home-workspaces-0f3a9c2e-1111-2222-3333-444455556666";
  const runningMessage = "This build has a run left going. Stop or resume it first.";

  const seededFiles = (runId: string): Record<string, string> => ({
    [`${workspace}/CLAUDE.md`]: "# fix-login",
    [`${worktreePath}/README.md`]: "# carousell-web",
    [`${sessionFolder}/notes.md`]: "plan",
    [`${home}/build-sessions/fd-build-other/notes.md`]: "other",
    [`${home}/runs/${runId}/output.log`]: "ran",
    [`${claudeConfig.projectsDir}/${slug}/s1.jsonl`]: "{}",
    [`${claudeConfig.projectsDir}/${slug}-carousell-web/s2.jsonl`]: "{}",
    [`${claudeConfig.projectsDir}/${slug}7/s3.jsonl`]: "{}",
    [`${claudeConfig.projectsDir}/-fd-home-workspaces/s4.jsonl`]: "{}",
    [`${claudeConfig.projectsDir}/-work-carousell-web/s5.jsonl`]: "{}",
    [claudeConfig.claudeJson]: JSON.stringify({
      numStartups: 3,
      projects: {
        [workspace]: { trusted: true },
        [worktreePath]: { trusted: true },
        [`${workspace}7`]: { trusted: true },
        "/work/carousell-web": { trusted: true },
      },
    }),
  });

  const setUp = (
    over: Partial<NewBuild> = {},
    prStates: Record<string, PullRequestState> = {},
    runStatus: "running" | "done" = "done",
  ) => {
    const store = new FakeStore();
    const build = { ...namedBuild(home, "/work/carousell-web"), ...over };
    store.recordBuild(build);
    const run = store.createRun(runOf(build));
    if (runStatus === "done") store.finishRun(run.id, "done");
    const fs = new FakeFileSystem(seededFiles(run.id));
    const worktree = new FakeWorktree();
    const pullRequests = new FakePullRequests(prStates);
    const deps = { store, worktree, fs, home, pullRequests, claudeConfig, sessionFolder };
    return { deps, store, fs, worktree, pullRequests, runId: run.id };
  };

  describe("while the build has a running run", () => {
    it("refuses, stops nothing and removes nothing", async () => {
      const { deps, store, fs, worktree, pullRequests, runId } = setUp({}, {}, "running");
      const before = seededFiles(runId);

      const result = await deleteBuild(deps, buildId);

      expect(result).toEqual({ ok: false, message: runningMessage });
      expect(store.findBuild(buildId)).toBeDefined();
      expect(store.findRun(runId)?.status).toBe("running");
      expect(worktree.removed).toEqual([]);
      expect(worktree.deletedBranches).toEqual([]);
      expect(worktree.deletedRemoteBranches).toEqual([]);
      expect(pullRequests.calls).toEqual([]);
      for (const [path, content] of Object.entries(before)) {
        expect(await fs.readFile(path)).toBe(content);
      }
    });
  });

  describe("removing its folders", () => {
    it("removes the workspace, the build-session folder and the workspace's Claude projects", async () => {
      const { deps, fs, worktree } = setUp();

      await deleteBuild(deps, buildId);

      expect(worktree.removed.map((removed) => removed.path)).toEqual([worktreePath]);
      expect(await fs.exists(workspace)).toBe(false);
      expect(await fs.exists(sessionFolder)).toBe(false);
      expect(await fs.folders(claudeConfig.projectsDir)).toEqual(
        ["-fd-home-workspaces", `${slug}7`, "-work-carousell-web"].sort(),
      );
    });

    it.each([
      [
        "readable",
        (fs: FakeFileSystem, content: string) => fs.writeFile(claudeConfig.claudeJson, content),
      ],
      [
        "private",
        (fs: FakeFileSystem, content: string) =>
          fs.writePrivateFile(claudeConfig.claudeJson, content),
      ],
    ])(
      "drops only the .claude.json projects at or inside the workspace, replacing the file and keeping it %s",
      async (mode, arrange) => {
        const { deps, fs } = setUp();
        await arrange(fs, await fs.readFile(claudeConfig.claudeJson));
        const callsBefore = fs.calls.length;

        await deleteBuild(deps, buildId);

        expect(JSON.parse(await fs.readFile(claudeConfig.claudeJson))).toEqual({
          numStartups: 3,
          projects: {
            [`${workspace}7`]: { trusted: true },
            "/work/carousell-web": { trusted: true },
          },
        });
        expect(
          fs.calls
            .slice(callsBefore)
            .filter(
              (call) =>
                call.path === claudeConfig.claudeJson &&
                call.method !== "exists" &&
                call.method !== "readFile",
            ),
        ).toEqual([{ method: "replaceFile", path: claudeConfig.claudeJson }]);
        expect(fs.isPrivate(claudeConfig.claudeJson)).toBe(mode === "private");
      },
    );

    it.each([
      ["is missing", (fs: FakeFileSystem) => fs.remove(claudeConfig.claudeJson)],
      [
        "has no projects",
        (fs: FakeFileSystem) => fs.writeFile(claudeConfig.claudeJson, '{"numStartups":3}'),
      ],
      [
        "is not valid JSON",
        (fs: FakeFileSystem) => fs.writeFile(claudeConfig.claudeJson, '{"projects":'),
      ],
      [
        "has no project at or inside the workspace",
        (fs: FakeFileSystem) =>
          fs.writeFile(claudeConfig.claudeJson, '{"projects":{"/work/carousell-web":{}}}'),
      ],
    ])("leaves .claude.json unwritten when it %s", async (_label, arrange) => {
      const { deps, fs } = setUp();
      await arrange(fs);
      const before = (await fs.exists(claudeConfig.claudeJson))
        ? await fs.readFile(claudeConfig.claudeJson)
        : undefined;

      const result = await deleteBuild(deps, buildId);

      expect(result).toEqual({ ok: true });
      expect(fs.calls).not.toContainEqual({
        method: "replaceFile",
        path: claudeConfig.claudeJson,
      });
      expect(
        (await fs.exists(claudeConfig.claudeJson))
          ? await fs.readFile(claudeConfig.claudeJson)
          : undefined,
      ).toBe(before);
    });

    it("keeps the run's folder and other build sessions", async () => {
      const { deps, fs, runId } = setUp();

      await deleteBuild(deps, buildId);

      expect(await fs.readFile(`${home}/runs/${runId}/output.log`)).toBe("ran");
      expect(await fs.readFile(`${home}/build-sessions/fd-build-other/notes.md`)).toBe("other");
    });
  });

  describe("for a branch it did not create", () => {
    it("never asks about a PR and leaves the branch locally and on the remote", async () => {
      const { deps, worktree, pullRequests } = setUp({ branch: "feat-y", branchCreated: false });

      const result = await deleteBuild(deps, buildId);

      expect(result).toEqual({ ok: true });
      expect(pullRequests.calls).toEqual([]);
      expect(worktree.removed).toEqual([
        {
          repo: "/work/carousell-web",
          base: "main",
          branch: "feat-y",
          create: false,
          path: worktreePath,
          force: true,
        },
      ]);
      expect(worktree.deletedBranches).toEqual([]);
      expect(worktree.deletedRemoteBranches).toEqual([]);
    });
  });

  describe("for a branch it created", () => {
    it("with no PR, deletes the branch locally and on the remote", async () => {
      const { deps, worktree, pullRequests } = setUp({ base: "release" });

      const result = await deleteBuild(deps, buildId);

      expect(result).toEqual({ ok: true });
      expect(pullRequests.calls).toEqual([{ repo: "/work/carousell-web", branch }]);
      expect(worktree.removed).toEqual([
        {
          repo: "/work/carousell-web",
          base: "release",
          branch,
          create: true,
          path: worktreePath,
          force: true,
        },
      ]);
      expect(worktree.deletedRemoteBranches).toEqual([
        { repo: "/work/carousell-web", branch, tip: `tip-of-${branch}` },
      ]);
    });

    it("keeps the branch on a remote where it points at work this build didn't make, and says where", async () => {
      const { deps, store, worktree } = setUp();
      vi.spyOn(worktree, "deleteRemoteBranch").mockResolvedValue(["origin"]);

      const result = await deleteBuild(deps, buildId);

      expect(result).toEqual({
        ok: true,
        kept: { kind: "branch", branch, reason: "remote-moved", remotes: ["origin"] },
      });
      expect(store.findBuild(buildId)).toBeUndefined();
    });

    it("finishes the delete and says the branch was kept when the remote delete fails", async () => {
      const { deps, store, fs, worktree } = setUp();
      vi.spyOn(worktree, "deleteRemoteBranch").mockRejectedValue(new Error("network down"));

      const result = await deleteBuild(deps, buildId);

      expect(result).toEqual({
        ok: true,
        kept: { kind: "branch", branch, reason: "remote-delete-failed" },
      });
      expect(store.findBuild(buildId)).toBeUndefined();
      expect(await fs.exists(sessionFolder)).toBe(false);
      expect(await fs.exists(`${claudeConfig.projectsDir}/${slug}`)).toBe(false);
      expect(fs.calls).toContainEqual({ method: "replaceFile", path: claudeConfig.claudeJson });
    });

    it("leaves every remote alone when the branch has no local tip to match", async () => {
      const { deps, store, worktree } = setUp();
      vi.spyOn(worktree, "branchTip").mockResolvedValue(undefined);

      const result = await deleteBuild(deps, buildId);

      expect(result).toEqual({ ok: true });
      expect(worktree.deletedRemoteBranches).toEqual([]);
      expect(store.findBuild(buildId)).toBeUndefined();
    });

    it.each([
      ["open", "open-pr"],
      ["unknown", "pr-unknown"],
    ] as const)(
      "with PR state %s, keeps the branch locally and on the remote and says why",
      async (state, reason) => {
        const { deps, worktree } = setUp({}, { [branch]: state });

        const result = await deleteBuild(deps, buildId);

        expect(result).toEqual({ ok: true, kept: { kind: "branch", branch, reason } });
        expect(worktree.removed).toEqual([
          {
            repo: "/work/carousell-web",
            base: "main",
            branch,
            create: false,
            path: worktreePath,
            force: true,
          },
        ]);
        expect(worktree.deletedBranches).toEqual([]);
        expect(worktree.deletedRemoteBranches).toEqual([]);
      },
    );

    it.each(["none", "open"] as const)(
      "with PR state %s, says the worktree was kept when its removal leaves it, and touches no remote",
      async (state) => {
        const { deps, store, worktree } = setUp({}, { [branch]: state });
        vi.spyOn(worktree, "remove").mockResolvedValue({ worktree: "kept", branch: "kept" });

        const result = await deleteBuild(deps, buildId);

        expect(result).toEqual({ ok: true, kept: { kind: "worktree", path: worktreePath } });
        expect(worktree.deletedRemoteBranches).toEqual([]);
        expect(store.findBuild(buildId)).toBeUndefined();
      },
    );
  });

  it("deletes the build from the store once, after the cleanup", async () => {
    const { deps, store, fs, worktree } = setUp();
    const removed = (path: string) =>
      fs.calls.some(
        (call) => call.path === path && (call.method === "removeTree" || call.method === "remove"),
      );
    const seen: unknown[] = [];
    const deleteFromStore = vi.spyOn(store, "deleteBuild").mockImplementation(() => {
      seen.push({
        worktrees: worktree.removed.length,
        remoteDeletes: worktree.deletedRemoteBranches.length,
        workspace: removed(workspace),
        sessionFolder: removed(sessionFolder),
        claudeJsonWritten: fs.calls.some(
          (call) => call.method === "replaceFile" && call.path === claudeConfig.claudeJson,
        ),
        claudeProject: removed(`${claudeConfig.projectsDir}/${slug}`),
      });
    });

    await deleteBuild(deps, buildId);

    expect(deleteFromStore).toHaveBeenCalledTimes(1);
    expect(deleteFromStore).toHaveBeenCalledWith(buildId);
    expect(seen).toEqual([
      {
        worktrees: 1,
        remoteDeletes: 1,
        workspace: true,
        sessionFolder: true,
        claudeJsonWritten: true,
        claudeProject: true,
      },
    ]);
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
      await fs.writePrivateFile(join(home, "claude", ".claude.json"), '{"projects":{}}\n');
    });

    afterEach(async () => {
      db.close();
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    });

    const deps = () => ({
      store,
      worktree,
      fs,
      home,
      pullRequests: new FakePullRequests(),
      claudeConfig: {
        projectsDir: join(home, "claude", "projects"),
        claudeJson: join(home, "claude", ".claude.json"),
      },
    });

    const makeBuild = async () => {
      const build = namedBuild(home, repo.path);
      const worktreePath = join(build.dir, basename(repo.path));
      await fs.writeFile(join(build.dir, "CLAUDE.md"), "# fix-login\n");
      await fs.writeFile(join(build.dir, "manifest.json"), "{}\n");
      await fs.writeFile(join(build.dir, "plugin", "commands", "p1.md"), "Fix FD-1\n");
      await worktree.add({
        repo: repo.path,
        base: "main",
        branch,
        path: worktreePath,
        create: true,
      });
      store.recordBuild(build);
      const finished = store.createRun(runOf(build));
      store.finishRun(finished.id, "done");
      return { build, worktreePath, runId: finished.id };
    };

    const expectGone = (runId: string) => {
      expect(store.findBuild(buildId)).toBeUndefined();
      expect(store.listBuilds().map((known) => known.id)).not.toContain(buildId);
      expect(store.listRuns()).toEqual([
        expect.objectContaining({ id: runId, buildId, buildGone: true }),
      ]);
      expect(store.findBuildByName("fix-login")).toBeUndefined();
    };

    it("removes a clean build's workspace, branch and row, keeps its runs listed and frees its name", async () => {
      const { build, worktreePath, runId } = await makeBuild();

      const result = await deleteBuild(deps(), buildId);

      expect(result).toEqual({ ok: true });
      expect(await exists(build.dir)).toBe(false);
      expect(await worktreePaths(repo.path)).not.toContain(worktreePath);
      expect(await branches(repo.path)).not.toContain(branch);
      expectGone(runId);
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
      "removes a worktree holding %s work with its branch, and keeps nothing",
      async (_label, work) => {
        const { build, worktreePath, runId } = await makeBuild();
        await work(worktreePath);

        const result = await deleteBuild(deps(), buildId);

        expect(result).toEqual({ ok: true });
        expect(await exists(worktreePath)).toBe(false);
        expect(await worktreePaths(repo.path)).not.toContain(worktreePath);
        expect(await branches(repo.path)).not.toContain(branch);
        expect(await exists(build.dir)).toBe(false);
        expectGone(runId);
      },
    );

    it("deletes a branch holding commits whose worktree folder is gone, and keeps nothing", async () => {
      const { build, worktreePath, runId } = await makeBuild();
      await writeFile(join(worktreePath, "notes.txt"), "work in progress\n");
      await git(worktreePath, "add", "notes.txt");
      await git(worktreePath, ...committer, "commit", "--quiet", "-m", "wip");
      await rm(worktreePath, { recursive: true, force: true });

      const result = await deleteBuild(deps(), buildId);

      expect(result).toEqual({ ok: true });
      expect(await branches(repo.path)).not.toContain(branch);
      expect(await exists(build.dir)).toBe(false);
      expectGone(runId);
    });

    const makeBuildOnExistingBranch = async () => {
      await git(repo.path, "branch", "feat-y");
      const build: NewBuild = {
        ...namedBuild(home, repo.path),
        branch: "feat-y",
        branchCreated: false,
      };
      const worktreePath = join(build.dir, basename(repo.path));
      await fs.writeFile(join(build.dir, "CLAUDE.md"), "# fix-login\n");
      await worktree.add({
        repo: repo.path,
        base: "main",
        branch: "feat-y",
        path: worktreePath,
        create: false,
      });
      store.recordBuild(build);
      const finished = store.createRun(runOf(build));
      store.finishRun(finished.id, "done");
      return { build, worktreePath, runId: finished.id };
    };

    it("keeps a branch it did not create, though merged into the base with nothing unpushed, and says nothing kept", async () => {
      const { build, worktreePath, runId } = await makeBuildOnExistingBranch();

      const result = await deleteBuild(deps(), buildId);

      expect(result).toEqual({ ok: true });
      expect(await branches(repo.path)).toContain("feat-y");
      expect(await worktreePaths(repo.path)).not.toContain(worktreePath);
      expect(await exists(build.dir)).toBe(false);
      expectGone(runId);
    });

    it("removes a dirty worktree on a branch it did not create, keeping the branch", async () => {
      const { build, worktreePath, runId } = await makeBuildOnExistingBranch();
      await writeFile(join(worktreePath, "notes.txt"), "work in progress\n");

      const result = await deleteBuild(deps(), buildId);

      expect(result).toEqual({ ok: true });
      expect(await worktreePaths(repo.path)).not.toContain(worktreePath);
      expect(await exists(build.dir)).toBe(false);
      expect(await branches(repo.path)).toContain("feat-y");
      expectGone(runId);
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

      const result = await deleteBuild(deps(), "oldhash1");

      expect(result).toEqual({ ok: true });
      expect(await exists(dir)).toBe(false);
      expect(store.findBuild("oldhash1")).toBeUndefined();
      expect(store.listBuilds().map((known) => known.id)).not.toContain("oldhash1");
    });

    it("leaves an old hash build's folder outside $FLOWDECK_HOME, even one beside it, and returns it", async () => {
      const dir = join(elsewhere, "oldhash2");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.json"), "{}\n");
      recordOldBuild("oldhash2", dir);

      const result = await deleteBuild(deps(), "oldhash2");

      expect(result).toEqual({ ok: true, kept: { kind: "folder", path: dir } });
      expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe("{}\n");
      expect(store.findBuild("oldhash2")).toBeUndefined();
    });

    it.each([
      [
        "under $FLOWDECK_HOME, with its Claude projects",
        () => join(home, "builds", "oldhash3"),
        false,
      ],
      [
        "outside $FLOWDECK_HOME, keeping its Claude projects",
        () => join(elsewhere, "oldhash3"),
        true,
      ],
    ])(
      "removes an old hash build's build-session folder when its folder is %s",
      async (_label, dirOf, claudeKept) => {
        const dir = dirOf();
        const sessionFolder = join(home, "build-sessions", "fd-build-old");
        const project = join(deps().claudeConfig.projectsDir, claudeProjectFolder(dir));
        const claudeJson = `${JSON.stringify({ projects: { [dir]: {} } }, null, 2)}\n`;
        await fs.writeFile(join(dir, "manifest.json"), "{}\n");
        await fs.writeFile(join(sessionFolder, "notes.md"), "plan\n");
        await fs.writeFile(join(project, "s1.jsonl"), "{}\n");
        await fs.replaceFile(deps().claudeConfig.claudeJson, claudeJson);
        recordOldBuild("oldhash3", dir);

        await deleteBuild({ ...deps(), sessionFolder }, "oldhash3");

        expect(await exists(sessionFolder)).toBe(false);
        expect(await exists(project)).toBe(claudeKept);
        expect(await readFile(deps().claudeConfig.claudeJson, "utf8")).toBe(
          claudeKept ? claudeJson : `${JSON.stringify({ projects: {} }, null, 2)}\n`,
        );
      },
    );
  });
});

describe("teardownWorkspace", () => {
  let repo: TmpRepo;
  let home: string;
  let db: Database.Database;
  let store: SqliteStore;
  const fs = new NodeFileSystem();

  beforeEach(async () => {
    repo = await createTmpRepo({ commit: true });
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-teardown-home-")));
    db = openDatabase({ path: join(home, "flowdeck.db") });
    store = new SqliteStore({ db });
  });

  afterEach(async () => {
    db.close();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  const layDownWorkspace = async () => {
    const dir = join(home, "workspaces", buildId);
    await fs.writeFile(join(dir, "CLAUDE.md"), "# fix-login\n");
    await fs.writeFile(join(dir, "plugin", "commands", "p1.md"), "Fix FD-1\n");
    return dir;
  };

  it("removes a workspace with no worktree, touching no worktree or branch", async () => {
    const dir = await layDownWorkspace();
    const worktree = new FakeWorktree();
    const deps = { worktree, fs, home };

    await teardownWorkspace(deps, { dir });

    expect(await exists(dir)).toBe(false);
    expect(worktree.removed).toEqual([]);
    expect(worktree.deletedBranches).toEqual([]);
  });

  it("removes the workspace, its worktree and its branch, with no build recorded", async () => {
    const dir = await layDownWorkspace();
    const worktreePath = join(dir, basename(repo.path));
    const worktree = new GitWorktree();
    await worktree.add({ repo: repo.path, base: "main", branch, path: worktreePath, create: true });
    const deps = { worktree, fs, home };

    await teardownWorkspace(deps, {
      dir,
      worktree: { repo: repo.path, base: "main", branch, create: true, path: worktreePath },
    });

    expect(store.findBuild(buildId)).toBeUndefined();
    expect(await exists(dir)).toBe(false);
    expect(await worktreePaths(repo.path)).not.toContain(worktreePath);
    expect(await branches(repo.path)).not.toContain(branch);
  });

  const commitIn = async (path: string) => {
    await writeFile(join(path, "notes.txt"), "work in progress\n");
    await git(path, "add", "notes.txt");
    await git(path, ...committer, "commit", "--quiet", "-m", "wip");
  };

  const layDownWorktree = async () => {
    const dir = await layDownWorkspace();
    const path = join(dir, basename(repo.path));
    const runWorktree = { repo: repo.path, base: "main", branch, create: true, path };
    await new GitWorktree().add(runWorktree);
    return { dir, runWorktree };
  };

  it.each([
    [
      "uncommitted",
      async (path: string) => {
        await writeFile(join(path, "notes.txt"), "work in progress\n");
      },
    ],
    ["committed but unpushed", commitIn],
  ])(
    "keeps a worktree holding %s work with its branch, removes the rest and returns the kept path",
    async (_label, work) => {
      const { dir, runWorktree } = await layDownWorktree();
      await work(runWorktree.path);

      const kept = await teardownWorkspace(
        { worktree: new GitWorktree(), fs },
        { dir, worktree: runWorktree },
      );

      expect(kept).toEqual({ kind: "worktree", path: runWorktree.path });
      expect(await readFile(join(runWorktree.path, "notes.txt"), "utf8")).toBe(
        "work in progress\n",
      );
      expect(await branches(repo.path)).toContain(branch);
      expect(await exists(join(dir, "CLAUDE.md"))).toBe(false);
      expect(await exists(join(dir, "plugin"))).toBe(false);
    },
  );

  it("keeps a branch holding commits whose worktree folder is gone, and says the branch was kept", async () => {
    const { dir, runWorktree } = await layDownWorktree();
    await commitIn(runWorktree.path);
    await rm(runWorktree.path, { recursive: true, force: true });

    const kept = await teardownWorkspace(
      { worktree: new GitWorktree(), fs },
      { dir, worktree: runWorktree },
    );

    expect(kept).toEqual({ kind: "branch", branch });
    expect(await branches(repo.path)).toContain(branch);
    expect(await exists(dir)).toBe(false);
  });
});

describe("teardownWorkspace on a branch it did not create", () => {
  let home: string;
  const fs = new NodeFileSystem();

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-teardown-existing-")));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const existingBranchWorkspace = async (worktree: FakeWorktree) => {
    const dir = join(home, "workspaces", buildId);
    await fs.writeFile(join(dir, "CLAUDE.md"), "# fix-login\n");
    const runWorktree = {
      repo: "/work/carousell-web",
      base: "main",
      branch: "feat-y",
      create: false,
      path: join(dir, "carousell-web"),
    };
    await worktree.add(runWorktree);
    return { dir, runWorktree };
  };

  it("removes the worktree, never asks about unpushed work or deletes the branch, and says nothing kept", async () => {
    const worktree = new FakeWorktree({ unpushed: ["feat-y"] });
    const hasUnpushed = vi.spyOn(worktree, "hasUnpushed");
    const { dir, runWorktree } = await existingBranchWorkspace(worktree);

    const kept = await teardownWorkspace({ worktree, fs }, { dir, worktree: runWorktree });

    expect(kept).toBeUndefined();
    expect(hasUnpushed).not.toHaveBeenCalled();
    expect(worktree.removed).toEqual([runWorktree]);
    expect(worktree.deletedBranches).toEqual([]);
    expect(worktree.branches).toContain("feat-y");
    expect(await exists(dir)).toBe(false);
  });

  it("says nothing kept when the worktree folder is already gone", async () => {
    const worktree = new FakeWorktree();
    const { dir, runWorktree } = await existingBranchWorkspace(worktree);
    await rm(runWorktree.path, { recursive: true, force: true });

    const kept = await teardownWorkspace({ worktree, fs }, { dir, worktree: runWorktree });

    expect(kept).toBeUndefined();
    expect(worktree.deletedBranches).toEqual([]);
  });

  it("still keeps a dirty worktree", async () => {
    const worktree = new FakeWorktree();
    const { dir, runWorktree } = await existingBranchWorkspace(worktree);
    const dirty = new FakeWorktree({ dirty: [runWorktree.path] });

    const kept = await teardownWorkspace({ worktree: dirty, fs }, { dir, worktree: runWorktree });

    expect(kept).toEqual({ kind: "worktree", path: runWorktree.path });
    expect(dirty.removed).toEqual([]);
    expect(dirty.deletedBranches).toEqual([]);
    expect(await exists(runWorktree.path)).toBe(true);
  });
});

describe("deletePreview", () => {
  const home = "/fd-home";
  const build = (over: Partial<BuildRecord> = {}): BuildRecord => ({
    id: buildId,
    hash: "abc",
    name: "fix-login",
    repo: "/work/carousell-web",
    base: "main",
    branch,
    branchCreated: true,
    values: {},
    deletedAt: null,
    dir: `${home}/workspaces/${buildId}`,
    createdAt: 1,
    blueprintName: null,
    blueprintVersion: null,
    ...over,
  });
  const worktreePath = `${home}/workspaces/${buildId}/carousell-web`;
  const presentWorktree = () =>
    new FakeFileSystem({ [`${worktreePath}/README.md`]: "# carousell-web" });

  it("reports a dirty present worktree", async () => {
    const worktree = new FakeWorktree({ dirty: [worktreePath] });

    expect(await deletePreview({ worktree, fs: presentWorktree() }, build())).toEqual({
      dirtyWorktree: true,
      unpushedBranch: false,
    });
  });

  it("reports a clean present worktree on a branch with nothing unpushed as losing nothing", async () => {
    const worktree = new FakeWorktree();

    expect(await deletePreview({ worktree, fs: presentWorktree() }, build())).toEqual({
      dirtyWorktree: false,
      unpushedBranch: false,
    });
  });

  it("reports unpushed commits on a branch Flowdeck made", async () => {
    const worktree = new FakeWorktree({ unpushed: [branch] });

    expect(await deletePreview({ worktree, fs: presentWorktree() }, build())).toEqual({
      dirtyWorktree: false,
      unpushedBranch: true,
    });
  });

  it("never reports unpushed commits on a branch Flowdeck did not make", async () => {
    const worktree = new FakeWorktree({ unpushed: ["feat-y"] });

    expect(
      await deletePreview(
        { worktree, fs: presentWorktree() },
        build({ branch: "feat-y", branchCreated: false }),
      ),
    ).toEqual({ dirtyWorktree: false, unpushedBranch: false });
  });

  it("reports nothing for a build with no worktree", async () => {
    const worktree = new FakeWorktree({ dirty: [worktreePath], unpushed: [branch] });

    expect(
      await deletePreview(
        { worktree, fs: new FakeFileSystem() },
        build({ name: null, repo: null, base: null, branch: null, branchCreated: null }),
      ),
    ).toEqual({ dirtyWorktree: false, unpushedBranch: false });
  });
});

describe("storedBranch", () => {
  const record = (over: Partial<BuildRecord>): BuildRecord => ({
    id: "0f3a9c2e5d",
    hash: "h1",
    name: "fix-login",
    repo: "/work/shop",
    base: "main",
    branch: "feat-y",
    branchCreated: false,
    values: {},
    deletedAt: null,
    dir: "/fd-home/workspaces/0f3a9c2e5d",
    createdAt: 1,
    blueprintName: null,
    blueprintVersion: null,
    ...over,
  });

  it.each([
    ["no branch", { branch: null, branchCreated: null }],
    ["a branch but not who made it", { branchCreated: null }],
  ])("gives a build recorded with %s the name Flowdeck derived and made", (_label, over) => {
    expect(storedBranch(record(over), "fix-login")).toEqual({
      branch: "flowdeck/fix-login-0f3a9c2e",
      create: true,
    });
  });
});

describe("claudeProjectFolder", () => {
  it("names a folder the way Claude Code does, every character but a letter or digit made a dash", () => {
    expect(claudeProjectFolder("/Users/me/.flowdeck/workspaces/a_b c")).toBe(
      "-Users-me--flowdeck-workspaces-a-b-c",
    );
  });
});

describe("deleteBuildResultSchema", () => {
  it("reads each kept kind, a plain delete and a refusal", () => {
    const results = [
      { ok: true },
      { ok: true, kept: { kind: "worktree", path: "/w" } },
      { ok: true, kept: { kind: "branch", branch: "flowdeck/b" } },
      { ok: true, kept: { kind: "branch", branch: "flowdeck/b", reason: "open-pr" } },
      { ok: true, kept: { kind: "branch", branch: "flowdeck/b", reason: "pr-unknown" } },
      {
        ok: true,
        kept: { kind: "branch", branch: "flowdeck/b", reason: "remote-moved", remotes: ["origin"] },
      },
      { ok: true, kept: { kind: "branch", branch: "flowdeck/b", reason: "remote-delete-failed" } },
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
