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
  values: null,
  deletedAt: null,
  dir: `${home}/builds/oldhash1`,
  createdAt: 1,
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

const live = build("live1234abcd", "keep", 2);
const gone = build("gone1234abcd", "gone", 1);
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
}: { files?: Record<string, string>; fs?: FakeFileSystem; worktree?: FakeWorktree } = {}) => {
  const runs = new StoreWithOldBuild({ now: () => new Date(deletedAtTime) });
  runs.recordBuild(live);
  runs.recordBuild(gone);
  runs.deleteBuild(gone.id);
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

    it("answers an unknown id with an error", async () => {
      const response = await send(setup(), "assistant-read-build", { id: "nope" });

      expect(response).toMatchObject({ ok: false, error: expect.stringContaining("nope") });
    });
  });
});
