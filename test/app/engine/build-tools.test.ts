import { describe, expect, it } from "vitest";
import {
  createEngineHandler,
  type EngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import type { OpenedSession } from "../../../src/core/run/execute.js";
import type { BuildRecord, NewBuild } from "../../../src/core/run/store.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import { fakeEngineBuildOptions } from "../../fixtures/fake-build-deps.js";

const home = "/fd";
const deletedAtTime = Date.UTC(2026, 0, 2);

const build = (id: string, name: string, version: number): NewBuild => ({
  id,
  hash: `hash-${id}`,
  name,
  repo: "/repos/app",
  base: "main",
  branch: `flowdeck/${name}-${id.slice(0, 8)}`,
  branchCreated: true,
  values: { ticket: "FD-1" },
  dir: `${home}/workspaces/${id}`,
  source: { flowId: "flow-1", version },
  files: [],
  nodes: [],
});

const oldBuild: BuildRecord = {
  id: "oldhash1",
  hash: "oldhash1",
  name: null,
  repo: null,
  base: null,
  branch: null,
  branchCreated: null,
  values: null,
  deletedAt: null,
  dir: `${home}/builds/oldhash1`,
  createdAt: 1,
  blueprintName: null,
  blueprintVersion: null,
};

class StoreWithOldBuild extends FakeStore {
  override listBuilds(): BuildRecord[] {
    return [...super.listBuilds(), oldBuild];
  }

  override listBuildsWithDeleted(): BuildRecord[] {
    return [...super.listBuildsWithDeleted(), oldBuild];
  }

  override findBuild(id: string): BuildRecord | undefined {
    return id === oldBuild.id ? oldBuild : super.findBuild(id);
  }
}

const lockedFiles = [
  { path: "CLAUDE.md", sha256: "c" },
  { path: "manifest.json", sha256: "m" },
  { path: "plugin/agents/a.md", sha256: "a" },
  { path: "plugin/templates/h.md", sha256: "h" },
];
const lockedPaths = lockedFiles.map(({ path }) => path).sort();

const live = { ...build("live1234abcd", "keep", 2), files: lockedFiles };
const gone = { ...build("gone1234abcd", "gone", 1), files: lockedFiles };
const liveDir = live.dir;
const liveWorktree = `${liveDir}/app`;
const liveBranch = "flowdeck/keep-live1234";

const workspaceFiles = {
  [`${liveDir}/CLAUDE.md`]: "# rules",
  [`${liveDir}/settings.json`]: "{}",
  [`${liveDir}/manifest.json`]: "{}",
  [`${liveDir}/plugin/.claude-plugin/plugin.json`]: "{}",
  [`${liveDir}/plugin/commands/p1.md`]: "do it",
  [`${liveWorktree}/.git`]: "gitdir: /repos/app/.git/worktrees/app",
  [`${liveWorktree}/src/index.ts`]: "export {};",
};

const setup = ({
  files = workspaceFiles,
  fs = new FakeFileSystem(files),
  worktree = new FakeWorktree({ dirty: [liveWorktree], unpushed: [liveBranch] }),
  builds = [],
  prepare = () => undefined,
}: {
  files?: Record<string, string>;
  fs?: FakeFileSystem;
  worktree?: FakeWorktree;
  builds?: NewBuild[];
  prepare?: (runs: FakeStore) => void;
} = {}) => {
  const runs = new StoreWithOldBuild({ now: () => new Date(deletedAtTime) });
  runs.recordBuild(live);
  runs.recordBuild(gone);
  runs.deleteBuild(gone.id);
  for (const added of builds) runs.recordBuild(added);
  prepare(runs);
  const options: EngineHandlerOptions = {
    version: "1.2.3",
    openStores: () => ({ runs, flows: new FakeFlowStore() }),
    home,
    publish: () => undefined,
    prepareHooks: () => ({
      kind: "ok",
      nodePath: "/usr/local/bin/node",
      hookScriptPath: `${home}/hooks/flowdeck-hook.cjs`,
      guardScriptPath: `${home}/hooks/flowdeck-build-guard.cjs`,
      webGuardScriptPath: `${home}/hooks/flowdeck-web-guard.cjs`,
    }),
    ...fakeEngineBuildOptions(fs),
    isFolder: () => true,
    fs,
    connectors: new FakeConnectorSource(),
    run: {
      fs,
      now: () => deletedAtTime,
      waiter: new FakeWaiter([]),
      startEvents: async () => ({ events: new FakeEventSource(), stop: async () => undefined }),
      openSession: async (): Promise<OpenedSession> => {
        throw new Error("no run starts in these tests");
      },
    } as EngineHandlerOptions["run"],
    worktree,
    gitState: new FakeGitState(),
    transcriptTurns: async () => [],
  };
  return createEngineHandler(options);
};

let nextId = 1;

const send = (handler: EngineHandler, type: string, payload?: unknown) =>
  handler.handle({
    id: nextId++,
    type: type as Parameters<EngineHandler["handle"]>[0]["type"],
    payload,
  });

const call = async (handler: EngineHandler, type: string, payload?: unknown) => {
  const response = await send(handler, type, payload);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};

describe("engine build tools", () => {
  describe("assistant-list-builds", () => {
    it("lists live, deleted and old builds, each with its state", async () => {
      const listed = (await call(setup(), "assistant-list-builds")) as unknown[];

      expect(listed).toHaveLength(3);
      expect(listed).toEqual(
        expect.arrayContaining([
          { id: live.id, name: "keep", blueprint: "flow-1", version: 2, state: "live" },
          { id: gone.id, name: "gone", blueprint: "flow-1", version: 1, state: "deleted" },
          { id: oldBuild.id, name: null, blueprint: null, version: null, state: "old" },
        ]),
      );
    });

    it("leaves the list-builds answer without deleted builds, in its own shape", async () => {
      const listed = (await call(setup(), "list-builds")) as { id: string; old: boolean }[];

      expect(listed.map(({ id }) => id).sort()).toEqual([live.id, oldBuild.id].sort());
      expect(listed.find(({ id }) => id === live.id)).toMatchObject({ name: "keep", old: false });
      expect(listed.find(({ id }) => id === oldBuild.id)).toMatchObject({ old: true });
    });
  });

  describe("assistant-read-build", () => {
    it("reports the repo, base, values, workspace tree without the repo folder, and the worktree's state", async () => {
      const read = (await call(setup(), "assistant-read-build", { id: live.id })) as {
        workspace: { tree: string[] };
      };

      expect(read).toMatchObject({ repo: "/repos/app", base: "main", values: { ticket: "FD-1" } });
      expect(read).toMatchObject({
        workspace: { path: liveDir, exists: true },
        worktree: { path: liveWorktree, exists: true, dirty: true, unpushed: true },
      });
      expect([...read.workspace.tree].sort()).toEqual([
        "CLAUDE.md",
        "manifest.json",
        "plugin/.claude-plugin/plugin.json",
        "plugin/commands/p1.md",
        "settings.json",
      ]);
    });

    it("lists the workspace without walking into the repo folder", async () => {
      const fs = new FakeFileSystem(workspaceFiles);

      await call(setup({ fs }), "assistant-read-build", { id: live.id });

      expect(fs.calls.filter((call) => call.method === "list")).toEqual([
        { method: "list", path: liveDir, skip: liveWorktree },
      ]);
    });

    it("reports a clean, pushed worktree as not dirty and not unpushed", async () => {
      const read = await call(setup({ worktree: new FakeWorktree() }), "assistant-read-build", {
        id: live.id,
      });

      expect(read).toMatchObject({
        worktree: { path: liveWorktree, exists: true, dirty: false, unpushed: false },
      });
    });

    it("reports a removed workspace as gone, with an empty tree and no git state", async () => {
      const read = await call(setup({ files: {} }), "assistant-read-build", { id: live.id });

      expect(read).toMatchObject({
        repo: "/repos/app",
        workspace: { path: liveDir, exists: false, tree: [] },
        worktree: { path: liveWorktree, exists: false, dirty: null, unpushed: null },
      });
    });

    it("asks git about the branch the build stored, not one made from its name", async () => {
      const onFeatY = {
        ...build("feat1234abcd", "feat", 1),
        branch: "feat-y",
        branchCreated: false,
      };
      const featWorktree = `${onFeatY.dir}/app`;
      const handler = setup({
        files: {
          ...workspaceFiles,
          [`${featWorktree}/.git`]: "gitdir: /repos/app/.git/worktrees/app",
        },
        worktree: new FakeWorktree({ unpushed: ["feat-y"] }),
        builds: [onFeatY],
      });

      const read = await call(handler, "assistant-read-build", { id: onFeatY.id });

      expect(read).toMatchObject({
        worktree: { path: featWorktree, exists: true, dirty: false, unpushed: true },
      });
    });

    it("answers an unknown id with an error", async () => {
      const response = await send(setup(), "assistant-read-build", { id: "nope" });

      expect(response).toMatchObject({ ok: false, error: expect.stringContaining("nope") });
    });
  });

  describe("build-tree", () => {
    it("answers a live build's locked paths from the database", async () => {
      const tree = (await call(setup(), "build-tree", { buildId: live.id })) as {
        deleted: boolean;
        paths: string[];
      };

      expect(tree.deleted).toBe(false);
      expect([...tree.paths].sort()).toEqual(lockedPaths);
    });

    it("answers a deleted build's paths as deleted without touching the file system", async () => {
      const fs = new FakeFileSystem(workspaceFiles);
      const handler = setup({ fs });
      const before = fs.calls.length;

      const tree = (await call(handler, "build-tree", { buildId: gone.id })) as {
        deleted: boolean;
        paths: string[];
      };

      expect(tree.deleted).toBe(true);
      expect([...tree.paths].sort()).toEqual(lockedPaths);
      expect(fs.calls.slice(before)).toEqual([]);
    });

    it("refuses an unknown build", async () => {
      const response = await send(setup(), "build-tree", { buildId: "nope" });

      expect(response).toMatchObject({ ok: false, error: expect.stringContaining("nope") });
    });
  });

  describe("build-project", () => {
    it("names the repo folder, checkout, branch, base and the checkout's git state", async () => {
      const project = await call(setup(), "build-project", { buildId: live.id });

      expect(project).toEqual({
        repoFolder: "app",
        path: liveWorktree,
        branch: liveBranch,
        branchCreated: true,
        base: "main",
        exists: true,
        dirty: true,
        unpushed: true,
      });
    });

    it("reports a clean, pushed checkout as not dirty and not unpushed", async () => {
      const project = await call(setup({ worktree: new FakeWorktree() }), "build-project", {
        buildId: live.id,
      });

      expect(project).toMatchObject({ exists: true, dirty: false, unpushed: false });
    });

    it("reports an existing branch as not created, with unpushed as git reports it", async () => {
      const onFeatY = {
        ...build("feat1234abcd", "feat", 1),
        branch: "feat-y",
        branchCreated: false,
      };
      const featWorktree = `${onFeatY.dir}/app`;
      const handler = setup({
        files: {
          ...workspaceFiles,
          [`${featWorktree}/.git`]: "gitdir: /repos/app/.git/worktrees/app",
        },
        worktree: new FakeWorktree({ unpushed: ["feat-y"] }),
        builds: [onFeatY],
      });

      const project = await call(handler, "build-project", { buildId: onFeatY.id });

      expect(project).toMatchObject({
        path: featWorktree,
        branch: "feat-y",
        branchCreated: false,
        exists: true,
        unpushed: true,
      });
    });

    it("reports a missing checkout as not existing", async () => {
      const project = await call(setup({ files: {} }), "build-project", { buildId: live.id });

      expect(project).toMatchObject({
        repoFolder: "app",
        path: liveWorktree,
        branch: liveBranch,
        exists: false,
      });
    });

    it.each([
      ["an old build", oldBuild.id],
      ["a deleted build", gone.id],
    ])("answers null for %s", async (_, buildId) => {
      const response = await send(setup(), "build-project", { buildId });

      expect(response).toMatchObject({ ok: true, value: null });
    });

    it("gives a missing checkout no git state rather than clean and pushed", async () => {
      const project = await call(setup({ files: {} }), "build-project", { buildId: live.id });

      expect(project).toMatchObject({ exists: false, dirty: null, unpushed: null });
    });

    it("refuses an unknown build", async () => {
      const response = await send(setup(), "build-project", { buildId: "nope" });

      expect(response).toMatchObject({ ok: false, error: expect.stringContaining("nope") });
    });
  });

  describe("build-entries", () => {
    it("lists the checkout's top level when asked for the repo folder", async () => {
      const fs = new FakeFileSystem(workspaceFiles);

      const entries = await call(setup({ fs }), "build-entries", { buildId: live.id, path: "app" });

      expect(entries).toEqual([
        { name: "src", kind: "folder" },
        { name: ".git", kind: "file" },
      ]);
      expect(fs.calls.filter((call) => call.method === "entries")).toEqual([
        { method: "entries", path: liveWorktree },
      ]);
    });

    it("lists one folder below the checkout", async () => {
      const entries = await call(setup(), "build-entries", { buildId: live.id, path: "app/src" });

      expect(entries).toEqual([{ name: "index.ts", kind: "file" }]);
    });

    it.each([
      ["the parent of the build", "../"],
      ["a path climbing out through the checkout", "app/../.."],
      ["an absolute path", "/etc"],
      ["the build root, above the checkout", ""],
      ["a build folder beside the checkout", "plugin"],
      ["a folder whose name starts with the checkout's", "apple"],
    ])("refuses %s without reading it", async (_, path) => {
      const fs = new FakeFileSystem(workspaceFiles);

      const response = await send(setup({ fs }), "build-entries", { buildId: live.id, path });

      expect(response).toMatchObject({ ok: false });
      expect(fs.calls.filter((call) => call.method === "entries")).toEqual([]);
    });

    it("lists the checkout's top level when the build folder has a doubled slash", async () => {
      const doubled = {
        ...build("dbl1234abcde", "dbl", 2),
        dir: `${home}//workspaces/dbl1234abcde`,
      };
      const fs = new FakeFileSystem({
        [`${home}/workspaces/dbl1234abcde/app/src/index.ts`]: "export {};",
      });

      const entries = await call(setup({ fs, builds: [doubled] }), "build-entries", {
        buildId: doubled.id,
        path: "app",
      });

      expect(entries).toEqual([{ name: "src", kind: "folder" }]);
    });

    it.each([
      ["a deleted build", gone.id],
      ["an old build", oldBuild.id],
      ["an unknown build", "nope"],
    ])("refuses %s without reading it", async (_, buildId) => {
      const fs = new FakeFileSystem(workspaceFiles);

      const response = await send(setup({ fs }), "build-entries", { buildId, path: "app" });

      expect(response).toMatchObject({ ok: false });
      expect(fs.calls.filter((call) => call.method === "entries")).toEqual([]);
    });
  });

  describe("pending-build-tree", () => {
    const pendingDir = `${home}/workspaces/pend1234abcd`;
    const pendingWorktree = `${pendingDir}/app`;
    const pendingFiles = {
      [`${pendingDir}/CLAUDE.md`]: "# rules",
      [`${pendingDir}/plugin/agents/a.md`]: "agent",
      [`${pendingWorktree}/.git`]: "gitdir: /repos/app/.git/worktrees/app",
      [`${pendingWorktree}/src/index.ts`]: "export {};",
    };

    const startPending = (runs: FakeStore, laidDown: boolean) => {
      const started = runs.startPendingBuild({
        flowId: "flow-1",
        version: 2,
        name: "pend",
        origin: {},
        startedAt: 1,
      });
      if (started.kind !== "started") throw new Error("pending build did not start");
      if (laidDown) {
        runs.appendBuildEvent(started.pendingId, {
          type: "worktree",
          status: "done",
          path: pendingWorktree,
          branch: "flowdeck/pend",
          base: "main",
        });
      }
      return started.pendingId;
    };

    const pendingSetup = (laidDown: boolean, files: Record<string, string>) => {
      let pendingId = "";
      const handler = setup({
        files,
        prepare: (runs) => {
          pendingId = startPending(runs, laidDown);
        },
      });
      return { handler, pendingId: () => pendingId };
    };

    it("answers null before the checkout is laid down", async () => {
      const { handler, pendingId } = pendingSetup(false, pendingFiles);

      const response = await send(handler, "pending-build-tree", { pendingId: pendingId() });

      expect(response).toMatchObject({ ok: true, value: null });
    });

    it("lists the workspace without the checkout once it is laid down", async () => {
      const { handler, pendingId } = pendingSetup(true, pendingFiles);

      const tree = await call(handler, "pending-build-tree", { pendingId: pendingId() });

      expect(tree).toEqual({ paths: ["CLAUDE.md", "plugin/agents/a.md"] });
    });

    it("leaves the checkout out when the home ends in a slash", async () => {
      let pendingId = "";
      const handler = setup({
        files: pendingFiles,
        prepare: (runs) => {
          const started = runs.startPendingBuild({
            flowId: "flow-1",
            version: 2,
            name: "pend",
            origin: {},
            startedAt: 1,
          });
          if (started.kind !== "started") throw new Error("pending build did not start");
          pendingId = started.pendingId;
          runs.appendBuildEvent(pendingId, {
            type: "worktree",
            status: "done",
            path: `${home}//workspaces/pend1234abcd/app`,
            branch: "flowdeck/pend",
            base: "main",
          });
        },
      });

      const tree = await call(handler, "pending-build-tree", { pendingId });

      expect(tree).toEqual({ paths: ["CLAUDE.md", "plugin/agents/a.md"] });
    });

    it("lists the workspace of the latest checkout laid down", async () => {
      const laterDir = `${home}/workspaces/later1234ab`;
      let pendingId = "";
      const handler = setup({
        files: {
          ...pendingFiles,
          [`${laterDir}/manifest.json`]: "{}",
          [`${laterDir}/app/src/index.ts`]: "export {};",
        },
        prepare: (runs) => {
          pendingId = startPending(runs, true);
          runs.appendBuildEvent(pendingId, {
            type: "worktree",
            status: "done",
            path: `${laterDir}/app`,
            branch: "flowdeck/pend",
            base: "main",
          });
        },
      });

      const tree = await call(handler, "pending-build-tree", { pendingId });

      expect(tree).toEqual({ paths: ["manifest.json"] });
    });

    it("answers null when the workspace folder is gone", async () => {
      const { handler, pendingId } = pendingSetup(true, {});

      const response = await send(handler, "pending-build-tree", { pendingId: pendingId() });

      expect(response).toMatchObject({ ok: true, value: null });
    });
  });
});
