import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";
import { GitFolderState } from "../../../src/adapters/git/git-state.js";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import {
  createEngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import { createAppWaiter } from "../../../src/app/engine/app-waiter.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { workspaceDir } from "../../../src/core/compiler/build.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { lower, type ManifestNode } from "../../../src/core/compiler/lower.js";
import { pieceOf } from "../../../src/core/compiler/pieces.js";
import { flowSvg } from "../../../src/core/flow/flow-svg.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import { agentType } from "../../../src/core/nodes/agent/execute.js";
import { markerOf } from "../../../src/core/run/agent-calls.js";
import { costOf, type UsageEntry } from "../../../src/core/run/budget.js";
import { deleteBuildResultSchema } from "../../../src/core/run/delete-build.js";
import type { OpenSessionOptions, OpenedSession } from "../../../src/core/run/execute.js";
import type { RepoState } from "../../../src/core/run/repo-state.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import type { PipelineGroup } from "../../../src/core/run/pipeline.js";
import { sessionFailureOf } from "../../../src/core/run/session-watch.js";
import { sessionWorktree, workspaceFolder } from "../../../src/core/run/workspace.js";
import type {
  BuildAgents,
  BuildAgentsOpenSpec,
  BuildTurnResult,
} from "../../../src/ports/build-agents.js";
import type { HookEventKind } from "../../../src/ports/event-source.js";
import type { FileSystem } from "../../../src/ports/file-system.js";
import type { FlowStore } from "../../../src/ports/flow-store.js";
import type { WorktreeAddOptions, WorktreeRemoveOptions } from "../../../src/ports/worktree.js";
import { FakeBuildAgents, type FakeBuildScript } from "../../fakes/fake-build-agents.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakeToolStartSource } from "../../fakes/fake-tool-start-source.js";
import { FakePullRequests } from "../../fakes/fake-pull-requests.js";
import { FakeRunNarrator } from "../../fakes/fake-run-narrator.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeUsageSource } from "../../fakes/fake-usage-source.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import {
  agent,
  ask,
  canvasPath,
  fork,
  workspaceContainer,
  workspaceFlow,
  gate,
  join as joinNode,
  loop,
  onWorkspaceMainFlow,
  output,
  sessionsWorkflow,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";
import { fakeEngineBuildOptions } from "../../fixtures/fake-build-deps.js";
import { fakeClaudeSession, type FakeTurnHandler } from "../../fixtures/fake-claude-session.js";

const git = async (repo: string, ...args: string[]): Promise<string> =>
  (await promisify(execFile)("git", ["-C", repo, ...args])).stdout;

const worktreePaths = async (repo: string): Promise<string[]> =>
  (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const branches = (repo: string): Promise<string> =>
  git(repo, "branch", "--list", "--format=%(refname:short)");

const stores = (flows = new FakeFlowStore()) => ({ runs: new FakeStore(), flows });

const gitAt = (...repos: string[]) =>
  new FakeGitState(
    Object.fromEntries(repos.map((repo) => [repo, { kind: "branch" as const, name: "main" }])),
  );

const jira = { type: "http", url: "https://mcp.example.com/jira" };

const savedFlow = () =>
  workspaceFlow(
    [trigger("start"), agent("plan"), output("stop")],
    [thenWire("start", "plan"), thenWire("plan", "stop")],
  );

const newBlueprint = () => ({ flowId: null, flow: savedFlow() });

const libraryUse = (libraryId: string) => ({
  id: "use",
  label: "Library",
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId, label: "Android App", overrides: {} },
});

const nodeLibrary = (label: string): Flow =>
  parseFlow({
    nodes: [trigger("canvas-start"), { ...agent("plan"), label }, output("canvas-stop")],
    wires: [thenWire("canvas-start", "plan"), thenWire("plan", "canvas-stop")],
    containers: [],
    settings: savedFlow().settings,
  });

const labelOf = (flow: Flow | null | undefined, nodeId: string) =>
  flow?.nodes.find((node) => node.id === nodeId)?.label;

const unreadable = (): never => {
  throw new Error("blueprints unreadable");
};

const unreadableFlows = (): FlowStore => ({
  create: unreadable,
  list: unreadable,
  rename: unreadable,
  pin: unreadable,
  delete: unreadable,
  isDeleted: unreadable,
  usedBy: unreadable,
  save: unreadable,
  loadLatest: unreadable,
  load: unreadable,
});

const manifestText = (input: Flow, hash: string): string => {
  const files = emit(lower(input, { name: "report", values: {} }), {
    repo: "/repo",
    base: "main",
    branch: "flowdeck/report",
    branchCreated: true,
    workspace: "/fd/workspaces/report",
  });
  const manifest = files.find((file) => file.path === "manifest.json");
  if (manifest === undefined) throw new Error("emit wrote no manifest.json");
  return canonicalJson({ ...(JSON.parse(manifest.content) as object), hash });
};

const failingOpen = () => {
  throw new Error("boom");
};

const isFolder = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const napsForever: FakeTurnHandler = (nodeId) => (nodeId === "nap" ? "hold" : "done");

const runEnvironment = (
  fs: NodeFileSystem,
  now: () => number = Date.now,
  turn: FakeTurnHandler = napsForever,
) => {
  const claude = fakeClaudeSession(turn);
  return {
    fs,
    now,
    waiter: new FakeWaiter([]),
    startEvents: claude.startEvents,
    openSession: claude.openSession,
  };
};

const heldStatesWrites = () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const writes: Promise<void>[] = [];
  let pending = 0;
  let holding = true;
  let started = 0;
  const fs = new (class extends NodeFileSystem {
    override writeFile(path: string, content: string): Promise<void> {
      if (!path.endsWith("session-states")) return super.writeFile(path, content);
      started++;
      if (!holding) return super.writeFile(path, content);
      pending++;
      const landed = gate
        .then(() => super.writeFile(path, content))
        .finally(() => {
          pending--;
        });
      writes.push(landed);
      return landed;
    }
  })();
  return {
    fs,
    release: () => open(),
    holdNoMore: () => {
      holding = false;
    },
    pendingStatesWrites: () => pending,
    statesWritesStarted: () => started,
    statesWritesLanded: async () => {
      let seen = -1;
      while (seen !== writes.length) {
        seen = writes.length;
        await Promise.allSettled(writes);
      }
    },
  };
};

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

const options = (overrides: Partial<EngineHandlerOptions> = {}): EngineHandlerOptions => {
  const fs = new NodeFileSystem();
  return {
    version: "1.2.3",
    openStores: () => stores(),
    home: "/fd-home",
    publish: () => undefined,
    prepareHooks: () => ({
      kind: "ok",
      nodePath: process.execPath,
      hookScriptPath: "/fd-home/hooks/flowdeck-hook.cjs",
      guardScriptPath: "/fd-home/hooks/flowdeck-build-guard.cjs",
      webGuardScriptPath: "/fd-home/hooks/flowdeck-web-guard.cjs",
    }),
    ...fakeEngineBuildOptions(fs),
    isFolder,
    fs,
    connectors: new FakeConnectorSource({ jira }),
    run: runEnvironment(fs),
    worktree: new FakeWorktree(),
    gitState: new FakeGitState(),
    transcriptTurns: async () => [],
    pullRequests: new FakePullRequests(),
    claudeConfig: {
      projectsDir: "/fd-home/claude/projects",
      claudeJson: "/fd-home/claude/.claude.json",
    },
    ...overrides,
  };
};

describe("createEngineHandler", async () => {
  it("answers a version request with the injected version under the request's id", async () => {
    const handler = createEngineHandler(options({ openStores: () => stores() }));

    expect(await handler.handle({ id: 1, type: "version" })).toEqual({
      id: 1,
      ok: true,
      value: "1.2.3",
    });
  });

  it("reports the store as ready when it opens", async () => {
    const handler = createEngineHandler(options({ openStores: () => stores() }));

    expect(await handler.handle({ id: 7, type: "store-status" })).toEqual({
      id: 7,
      ok: true,
      value: { kind: "ready" },
    });
  });

  it("reports the open error as the store status instead of throwing", async () => {
    const handler = createEngineHandler(options({ openStores: failingOpen }));

    expect(await handler.handle({ id: 2, type: "store-status" })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
  });

  it("opens the store once however many status requests arrive", async () => {
    let opens = 0;
    const handler = createEngineHandler(
      options({
        openStores: () => {
          opens++;
          return stores();
        },
      }),
    );

    await handler.handle({ id: 1, type: "store-status" });
    await handler.handle({ id: 2, type: "store-status" });
    await handler.handle({ id: 3, type: "store-status" });

    expect(opens).toBe(1);
  });

  it("opens the stores once across status, save and open requests", async () => {
    let opens = 0;
    const handler = createEngineHandler(
      options({
        openStores: () => {
          opens++;
          return stores();
        },
      }),
    );

    await handler.handle({ id: 1, type: "store-status" });
    await handler.handle({ id: 2, type: "save-flow", payload: newBlueprint() });
    await handler.handle({ id: 3, type: "open-flow", payload: {} });
    await handler.handle({ id: 4, type: "save-flow", payload: newBlueprint() });

    expect(opens).toBe(1);
  });

  it("saves a valid flow payload as version 1 and keeps it in the flow store", async () => {
    const flows = new FakeFlowStore({ newId: () => "flow-a" });
    const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

    expect(await handler.handle({ id: 5, type: "save-flow", payload: newBlueprint() })).toEqual({
      id: 5,
      ok: true,
      value: { kind: "saved", flowId: "flow-a", version: 1 },
    });
    expect(flows.loadLatest()).toEqual({
      flowId: "flow-a",
      name: "Untitled",
      version: 1,
      flow: savedFlow(),
    });
  });

  it("appends the next version to the same flow on a second save", async () => {
    const flows = new FakeFlowStore({ newId: () => "flow-a" });
    const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

    await handler.handle({ id: 1, type: "save-flow", payload: newBlueprint() });

    expect(
      await handler.handle({
        id: 2,
        type: "save-flow",
        payload: { flowId: "flow-a", flow: savedFlow() },
      }),
    ).toEqual({
      id: 2,
      ok: true,
      value: { kind: "saved", flowId: "flow-a", version: 2 },
    });
  });

  it("returns an error result and saves nothing when the payload is not a flow", async () => {
    const flows = new FakeFlowStore();
    const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

    expect(
      await handler.handle({
        id: 3,
        type: "save-flow",
        payload: { flowId: null, flow: { nodes: "nope" } },
      }),
    ).toEqual({
      id: 3,
      ok: true,
      value: { kind: "error", message: expect.stringMatching(/\S/) },
    });
    expect(flows.loadLatest()).toBeNull();
  });

  it("returns the store's error as an error result when the save throws", async () => {
    const flows = new FakeFlowStore();
    flows.failNextSave(new Error("disk full"));
    const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

    expect(await handler.handle({ id: 4, type: "save-flow", payload: newBlueprint() })).toEqual({
      id: 4,
      ok: true,
      value: { kind: "error", message: "disk full" },
    });
    expect(flows.loadLatest()).toBeNull();
  });

  it("returns errors for save and open when the stores fail to open", async () => {
    const handler = createEngineHandler(options({ openStores: failingOpen }));

    expect(await handler.handle({ id: 1, type: "save-flow", payload: newBlueprint() })).toEqual({
      id: 1,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
    expect(await handler.handle({ id: 2, type: "open-flow", payload: {} })).toEqual({
      id: 2,
      ok: false,
      error: "boom",
    });
    expect(await handler.handle({ id: 3, type: "store-status" })).toEqual({
      id: 3,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
  });

  describe("blueprints", () => {
    const ids = (...list: string[]) => {
      const queue = [...list];
      return () => queue.shift() ?? "spare";
    };

    it("saves, lists, renames and opens blueprints, each keeping its own versions", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      const second = onWorkspaceMainFlow([agent("other")], []);

      const savedA = await handler.handle({
        id: 3,
        type: "save-flow",
        payload: { flowId: null, name: "A", flow: savedFlow() },
      });
      await handler.handle({
        id: 4,
        type: "save-flow",
        payload: { flowId: null, name: "B", flow: second },
      });
      const renamed = await handler.handle({
        id: 5,
        type: "rename-flow",
        payload: { flowId: "flow-a", name: "Weekly" },
      });

      expect(savedA).toEqual({
        id: 3,
        ok: true,
        value: { kind: "saved", flowId: "flow-a", version: 1 },
      });
      expect(renamed).toEqual({ id: 5, ok: true, value: null });
      expect(await handler.handle({ id: 6, type: "list-flows" })).toMatchObject({
        ok: true,
        value: [
          { flowId: "flow-b", name: "B", versions: 1 },
          { flowId: "flow-a", name: "Weekly", versions: 1 },
        ],
      });
      expect(
        await handler.handle({ id: 7, type: "open-flow", payload: { flowId: "flow-a" } }),
      ).toEqual({
        id: 7,
        ok: true,
        value: { flowId: "flow-a", name: "Weekly", version: 1, flow: savedFlow() },
      });
      expect(await handler.handle({ id: 8, type: "open-flow", payload: {} })).toEqual({
        id: 8,
        ok: true,
        value: { flowId: "flow-b", name: "B", version: 1, flow: second },
      });
    });

    it("creates the blueprint by name and saves its version 1 in one request when it has no id yet", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      await handler.handle({ id: 1, type: "save-flow", payload: newBlueprint() });

      expect(
        await handler.handle({
          id: 2,
          type: "save-flow",
          payload: { flowId: null, name: "Second", flow: savedFlow() },
        }),
      ).toEqual({ id: 2, ok: true, value: { kind: "saved", flowId: "flow-b", version: 1 } });
      expect(flows.list().map(({ name, versions }) => [name, versions])).toEqual([
        ["Second", 1],
        ["Untitled", 1],
      ]);
    });

    it("leaves no empty blueprint when the first save of a new one fails", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
      flows.failNextSave(new Error("disk full"));
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

      expect(
        await handler.handle({
          id: 1,
          type: "save-flow",
          payload: { flowId: null, name: "Report", flow: savedFlow() },
        }),
      ).toEqual({ id: 1, ok: true, value: { kind: "error", message: "disk full" } });
      expect(flows.list()).toEqual([]);
    });

    it("opens a blueprint never saved as its name with no version, and nothing before any blueprint", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

      expect(await handler.handle({ id: 1, type: "open-flow", payload: {} })).toEqual({
        id: 1,
        ok: true,
        value: null,
      });
      flows.create("Fresh");

      expect(
        await handler.handle({ id: 3, type: "open-flow", payload: { flowId: "flow-a" } }),
      ).toEqual({
        id: 3,
        ok: true,
        value: { flowId: "flow-a", name: "Fresh", version: null, flow: null },
      });
    });

    describe("expand-flow", () => {
      const expand = (handler: ReturnType<typeof createEngineHandler>, flow: unknown) =>
        handler.handle({ id: 1, type: "expand-flow" as never, payload: { flow } });

      it("answers the flow with each library spliced in, and the libraries it used", async () => {
        const flows = new FakeFlowStore({ newId: ids("flow-lib") });
        flows.save(nodeLibrary("Planner"), { name: "Android" });
        const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

        const answered = await expand(handler, onWorkspaceMainFlow([libraryUse("flow-lib")], []));

        const { flow, uses } = (answered as { value: { flow: Flow; uses: unknown } }).value;
        expect(labelOf(flow, "android-app-plan")).toBe("Planner");
        expect(flow.nodes.filter((node) => node.type === "library")).toEqual([]);
        expect(uses).toEqual([{ path: "android-app", name: "Android", kind: "node-library" }]);
      });

      it("answers the problem instead when a library cannot be spliced in", async () => {
        const handler = createEngineHandler(options({ openStores: () => stores() }));

        expect(await expand(handler, onWorkspaceMainFlow([libraryUse("gone")], []))).toMatchObject({
          ok: true,
          value: { problem: "Android App names a library that does not exist" },
        });
      });

      it("answers a stored library loop with the path, naming the host's library", async () => {
        const flows = new FakeFlowStore({ newId: ids("loop-a", "loop-b") });
        const usingLibrary = (usedId: string): Flow =>
          parseFlow({
            nodes: [
              trigger("canvas-start"),
              {
                ...libraryUse(usedId),
                settings: { libraryId: usedId, label: "Uses", overrides: {} },
              },
              output("canvas-stop"),
            ],
            wires: [thenWire("canvas-start", "use"), thenWire("use", "canvas-stop")],
            containers: [],
            settings: savedFlow().settings,
          });
        flows.save(nodeLibrary("Planner"), { name: "LoopA" });
        flows.save(usingLibrary("loop-a"), { name: "LoopB" });
        flows.save(usingLibrary("loop-b"), "loop-a");
        const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

        expect(
          await expand(handler, onWorkspaceMainFlow([libraryUse("loop-a")], [])),
        ).toMatchObject({
          ok: true,
          value: { problem: "LoopA makes a loop: LoopA → LoopB → LoopA" },
        });
      });

      it("shows a library's later save the next time its user is opened, keeping only the library node in the blueprint", async () => {
        const flows = new FakeFlowStore({ newId: ids("flow-lib", "flow-host") });
        flows.save(nodeLibrary("Planner"), { name: "Android" });
        flows.save(onWorkspaceMainFlow([libraryUse("flow-lib")], []), { name: "Host" });
        const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
        const openHost = async () =>
          (
            (await handler.handle({
              id: 2,
              type: "open-flow",
              payload: { flowId: "flow-host" },
            })) as { value: { flow: Flow } }
          ).value.flow;
        const expandedLabel = async (flow: Flow) =>
          labelOf(
            ((await expand(handler, flow)) as { value: { flow: Flow } }).value.flow,
            "android-app-plan",
          );

        expect(await expandedLabel(await openHost())).toBe("Planner");
        flows.save(nodeLibrary("Reviewer"), "flow-lib");
        const reopened = await openHost();

        expect(await expandedLabel(reopened)).toBe("Reviewer");
        expect(labelOf(reopened, "android-app-plan")).toBeUndefined();
        expect(reopened.nodes.filter((node) => node.type === "library")).toHaveLength(1);
      });
    });

    it("pins a blueprint, so the list shows it pinned", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      flows.create("A");
      flows.create("B");

      expect(
        await handler.handle({
          id: 1,
          type: "pin-flow",
          payload: { flowId: "flow-a", pinned: true },
        }),
      ).toEqual({ id: 1, ok: true, value: null });
      expect(await handler.handle({ id: 2, type: "list-flows" })).toMatchObject({
        ok: true,
        value: [
          { flowId: "flow-b", pinned: false },
          { flowId: "flow-a", pinned: true },
        ],
      });
    });

    it("refuses a rename to a blank name, a save to an unknown blueprint and an unknown open", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      flows.create("A");

      expect(
        await handler.handle({
          id: 2,
          type: "rename-flow",
          payload: { flowId: "flow-a", name: " " },
        }),
      ).toEqual({ id: 2, ok: false, error: "A blueprint needs a name" });
      expect(
        await handler.handle({
          id: 3,
          type: "save-flow",
          payload: { flowId: "nope", flow: savedFlow() },
        }),
      ).toEqual({ id: 3, ok: true, value: { kind: "error", message: "No blueprint nope" } });
      expect(
        await handler.handle({ id: 4, type: "open-flow", payload: { flowId: "nope" } }),
      ).toEqual({ id: 4, ok: false, error: "No blueprint nope" });
    });

    it("deletes a blueprint, so the list leaves it out", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      flows.create("A");
      flows.create("B");

      expect(
        await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-a" } }),
      ).toEqual({ id: 1, ok: true, value: null });
      expect(await handler.handle({ id: 2, type: "list-flows" })).toMatchObject({
        ok: true,
        value: [{ flowId: "flow-b", name: "B" }],
      });
    });

    it("answers that a deleted blueprint was deleted, and an unknown one that it does not exist", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      flows.create("A");
      await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-a" } });

      expect(
        await handler.handle({ id: 2, type: "open-flow", payload: { flowId: "flow-a" } }),
      ).toEqual({ id: 2, ok: false, error: "Blueprint flow-a was deleted" });
      expect(
        await handler.handle({ id: 3, type: "open-flow", payload: { flowId: "nope" } }),
      ).toEqual({ id: 3, ok: false, error: "No blueprint nope" });
    });

    it("opens the newest live blueprint when the newest one was deleted", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      const second = onWorkspaceMainFlow([agent("other")], []);
      await handler.handle({
        id: 1,
        type: "save-flow",
        payload: { flowId: null, name: "A", flow: savedFlow() },
      });
      await handler.handle({
        id: 2,
        type: "save-flow",
        payload: { flowId: null, name: "B", flow: second },
      });
      await handler.handle({ id: 3, type: "delete-flow", payload: { flowId: "flow-b" } });

      expect(await handler.handle({ id: 4, type: "open-flow", payload: {} })).toEqual({
        id: 4,
        ok: true,
        value: { flowId: "flow-a", name: "A", version: 1, flow: savedFlow() },
      });
    });

    it("refuses to rename or pin a deleted blueprint", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a") });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      flows.create("A");
      await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-a" } });

      expect(
        await handler.handle({
          id: 2,
          type: "rename-flow",
          payload: { flowId: "flow-a", name: "Weekly" },
        }),
      ).toMatchObject({ id: 2, ok: false });
      expect(
        await handler.handle({
          id: 3,
          type: "pin-flow",
          payload: { flowId: "flow-a", pinned: true },
        }),
      ).toMatchObject({ id: 3, ok: false });
    });

    const startBuilding = (runs: FakeStore, flowId: string) => {
      const start = runs.startPendingBuild({
        flowId,
        version: 1,
        name: `build-of-${flowId}`,
        origin: { source: { flowId, version: 1 }, blueprint: { name: "Untitled", version: 1 } },
        startedAt: 1_000,
      });
      if (start.kind !== "started") throw new Error(`the build of ${flowId} did not start`);
      return start.pendingId;
    };

    it("refuses to delete a blueprint while it is being built, and deletes it once that build has ended", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a") });
      const runs = new FakeStore();
      const handler = createEngineHandler(options({ openStores: () => ({ runs, flows }) }));
      flows.create("A");
      const pendingId = startBuilding(runs, "flow-a");

      expect(
        await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-a" } }),
      ).toEqual({ id: 1, ok: false, error: expect.stringMatching(/\S/) });
      expect(flows.isDeleted("flow-a")).toBe(false);

      runs.endPendingBuild(pendingId, { outcome: "failed", endedAt: 2_000 });

      expect(
        await handler.handle({ id: 2, type: "delete-flow", payload: { flowId: "flow-a" } }),
      ).toEqual({ id: 2, ok: true, value: null });
      expect(flows.isDeleted("flow-a")).toBe(true);
    });

    it("deletes a blueprint while another blueprint is being built", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
      const runs = new FakeStore();
      const handler = createEngineHandler(options({ openStores: () => ({ runs, flows }) }));
      flows.create("A");
      flows.create("B");
      startBuilding(runs, "flow-b");

      expect(
        await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-a" } }),
      ).toEqual({ id: 1, ok: true, value: null });
      expect(flows.isDeleted("flow-a")).toBe(true);
    });

    it("refuses to delete a library a blueprint uses, naming that blueprint", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-b", "flow-a") });
      flows.save(nodeLibrary("Planner"), { name: "B" });
      flows.save(onWorkspaceMainFlow([libraryUse("flow-b")], []), { name: "A" });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

      expect(
        await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-b" } }),
      ).toEqual({
        id: 1,
        ok: false,
        error: "This library is used by A. Remove it from those blueprints before deleting it.",
      });
      expect(flows.list().map(({ flowId }) => flowId)).toContain("flow-b");
    });

    it("refuses to delete a library whose only use is off the main flow", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-b", "flow-w") });
      flows.save(nodeLibrary("Planner"), { name: "B" });
      const off = savedFlow();
      flows.save(parseFlow({ ...off, nodes: [...off.nodes, libraryUse("flow-b")] }), {
        name: "W",
      });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

      expect(
        await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-b" } }),
      ).toEqual({ id: 1, ok: false, error: expect.stringContaining("used by W.") });
      expect(flows.list().map(({ flowId }) => flowId)).toContain("flow-b");
    });

    it("deletes a library once no blueprint uses it", async () => {
      const flows = new FakeFlowStore({ newId: ids("flow-b", "flow-a") });
      flows.save(nodeLibrary("Planner"), { name: "B" });
      flows.save(onWorkspaceMainFlow([libraryUse("flow-b")], []), { name: "A" });
      const handler = createEngineHandler(options({ openStores: () => stores(flows) }));
      await handler.handle({ id: 1, type: "delete-flow", payload: { flowId: "flow-b" } });

      flows.save(onWorkspaceMainFlow([agent("plan")], []), "flow-a");

      expect(
        await handler.handle({ id: 2, type: "delete-flow", payload: { flowId: "flow-b" } }),
      ).toEqual({ id: 2, ok: true, value: null });
      expect(flows.list().map(({ flowId }) => flowId)).toEqual(["flow-a"]);
    });

    it("names the blueprint of each build in the progress list, going or ended", async () => {
      const runs = new FakeStore();
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: new FakeFlowStore() }) }),
      );
      const going = startBuilding(runs, "flow-a");
      const ended = startBuilding(runs, "flow-b");
      runs.endPendingBuild(ended, { outcome: "failed", endedAt: 2_000 });

      const listed = await handler.handle({ id: 1, type: "build-progress-list" });

      expect(listed).toMatchObject({ ok: true });
      const entries = (listed as { value: { pendingId: string; flowId?: string }[] }).value;
      expect(entries.map(({ pendingId, flowId }) => ({ pendingId, flowId }))).toEqual(
        expect.arrayContaining([
          { pendingId: going, flowId: "flow-a" },
          { pendingId: ended, flowId: "flow-b" },
        ]),
      );
      expect(entries).toHaveLength(2);
    });
  });

  describe("runs", () => {
    const builtFlow = () =>
      onWorkspaceMainFlow(
        [
          { ...agent("s1"), label: "Plan" },
          { ...agent("s2"), label: "Ship" },
        ],
        [thenWire("s1", "s2")],
      );

    const builtStages = {
      session: { name: "workspace" },
      nodes: [
        { id: "start", type: "trigger", label: "start" },
        { id: "s1", type: "agent", label: "Plan" },
        { id: "s2", type: "agent", label: "Ship" },
        { id: "stop", type: "output", label: "stop" },
      ],
      wires: [thenWire("start", "s1"), thenWire("s1", "s2"), thenWire("s2", "stop")],
    };

    const seededRun = (built: Flow = builtFlow(), nodeIds = ["s1", "s2"]) => {
      const flows = new FakeFlowStore({ newId: () => "flow-a" });
      const runs = new FakeStore();
      flows.create("Report");
      const { version } = flows.save(built, "flow-a");
      runs.recordBuild({
        id: "b1",
        hash: "h1",
        name: "report",
        repo: "/repo",
        base: "main",
        branch: "flowdeck/report",
        branchCreated: true,
        values: {},
        dir: "/fd-home/workspaces/b1",
        source: { flowId: "flow-a", version },
        files: [],
        nodes: [],
        manifest: manifestText(built, "h1"),
      });
      const pending = runs.startPendingBuild({
        flowId: "flow-a",
        version,
        name: "report",
        origin: {
          source: { flowId: "flow-a", version },
          blueprint: { name: "Report", version },
        },
        startedAt: 0,
        snapshot: { blueprintName: "Report", version, svg: flowSvg(built) },
      });
      if (pending.kind !== "started") throw new Error("the pending build did not start");
      runs.endPendingBuild(pending.pendingId, { outcome: "built", endedAt: 1, buildId: "b1" });
      const { id } = runs.createRun({
        buildDir: "/fd-home/workspaces/b1",
        inputs: {},
        nodeIds,
        session: {
          tmuxName: "fd-run-x",
          cwd: "/fd-home/workspaces/b1/repo",
          claudeSessionId: "c1",
        },
        buildId: "b1",
      });
      runs.append(id, "s1", { kind: "sent" });
      runs.append(id, "s1", { kind: "done" });
      runs.finishRun(id, "failed");
      return { flows, runs, runId: id };
    };

    it("lists runs with the build, its name and the blueprint version they came from", async () => {
      const { flows, runs, runId } = seededRun();
      const handler = createEngineHandler(options({ openStores: () => ({ runs, flows }) }));

      expect(await handler.handle({ id: 1, type: "list-runs" })).toEqual({
        id: 1,
        ok: true,
        value: [
          expect.objectContaining({
            id: runId,
            status: "failed",
            buildId: "b1",
            source: { flowId: "flow-a", version: 1 },
            buildName: "report",
            blueprintName: "Report",
            blueprintVersion: 1,
            buildGone: false,
            number: 1,
            doneCount: 1,
          }),
        ],
      });
    });

    it("lists builds with the blueprint name and version of their snapshot", async () => {
      const { flows, runs } = seededRun();
      const handler = createEngineHandler(options({ openStores: () => ({ runs, flows }) }));

      expect(await handler.handle({ id: 1, type: "list-builds" })).toEqual({
        id: 1,
        ok: true,
        value: [
          expect.objectContaining({
            id: "b1",
            name: "report",
            blueprintName: "Report",
            blueprintVersion: 1,
          }),
        ],
      });
    });

    describe("a run of a workspace-only blueprint", () => {
      const workspaceOnly = () =>
        canvasPath(
          workspaceFlow(
            [trigger("start"), agent("w1"), output("stop")],
            [thenWire("start", "w1"), thenWire("w1", "stop")],
            undefined,
            { containers: [workspaceContainer(["start", "w1", "stop"])] },
          ),
        );

      const seededWorkspaceRun = () => {
        const runs = new FakeStore();
        runs.recordBuild({
          id: "b9",
          hash: "h9",
          name: "workspace-only",
          repo: "/repo",
          base: "main",
          branch: "flowdeck/workspace-only",
          branchCreated: true,
          values: {},
          dir: "/fd-home/workspaces/b9",
          files: [],
          nodes: [],
          manifest: manifestText(workspaceOnly(), "h9"),
        });
        const { id: runId } = runs.createRun({
          buildDir: "/fd-home/workspaces/b9",
          inputs: {},
          nodeIds: ["w1"],
          session: {
            tmuxName: "left-b9",
            cwd: "/fd-home/workspaces/b9/repo",
            claudeSessionId: "c9",
          },
          buildId: "b9",
        });
        runs.append(runId, "w1", { kind: "sent" });
        runs.append(runId, "w1", { kind: "done" });
        return { runs, runId };
      };

      const finished = () => {
        const seeded = seededWorkspaceRun();
        seeded.runs.finishRun(seeded.runId, "done");
        return seeded;
      };

      it("lists a workspace-only run without reading its events", async () => {
        const { runs, runId } = finished();
        const events = vi.spyOn(runs, "events");
        runs.listRuns();
        const readsByListRuns = events.mock.calls.length;
        events.mockClear();
        const handler = createEngineHandler(
          options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
        );

        expect(await handler.handle({ id: 1, type: "list-runs" })).toEqual({
          id: 1,
          ok: true,
          value: [expect.objectContaining({ id: runId, doneCount: 1 })],
        });
        expect(events).toHaveBeenCalledTimes(readsByListRuns);
      });

      it("reads the run's after-state from its session's folder", async () => {
        const { runs, runId } = seededWorkspaceRun();
        const gitState = new FakeGitState();
        const after: RepoState = {
          kind: "read",
          branch: "flowdeck/workspace-only",
          head: "fee1234",
          upstream: null,
          staged: 0,
          unstaged: 0,
          untracked: 0,
        };
        gitState.repoStates.set("/fd-home/workspaces/b9/repo", after);
        const handler = createEngineHandler(
          options({ openStores: () => ({ runs, flows: unreadableFlows() }), gitState }),
        );

        expect(await handler.handle({ id: 1, type: "stop-run", payload: { runId } })).toMatchObject(
          { ok: true, value: { stopped: true } },
        );

        expect(runs.repoStates(runId).after).toEqual(after);
      });
    });

    it("loads one run with its build's name, its stages from the stored manifest and each node's status, reading no blueprint", async () => {
      const { runs, runId } = seededRun();
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      expect(await handler.handle({ id: 1, type: "load-run", payload: { runId } })).toEqual({
        id: 1,
        ok: true,
        value: {
          run: expect.objectContaining({ id: runId, status: "failed" }),
          name: "report",
          stages: builtStages,
          snapshot: { runId, status: "failed", nodes: { s1: "done", s2: "waiting" } },
          activity: [],
          story: {
            header: {
              name: "report",
              blueprintName: "Report",
              blueprintVersion: 1,
              repo: "/repo",
              branch: "flowdeck/report",
              values: {},
            },
            digest: expect.stringMatching(/\S/),
            written: null,
          },
        },
      });
      expect(await handler.handle({ id: 2, type: "load-run", payload: { runId: "nope" } })).toEqual(
        { id: 2, ok: false, error: "No run nope" },
      );
    });

    it("lists what each gate and ask asked in a loaded run's digest, from their settings in the stored manifest", async () => {
      const { runs, runId } = seededRun(
        onWorkspaceMainFlow(
          [
            gate("s1", { settings: { shown: "Approve the release notes", skippable: false } }),
            ask("s2", { settings: { question: "Which channel ships it?", options: ["a", "b"] } }),
          ],
          [thenWire("s1", "s2")],
        ),
      );
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      const loaded = await handler.handle({ id: 1, type: "load-run", payload: { runId } });

      expect((loaded as { error?: string }).error).toBeUndefined();
      const digest = (loaded as { value: { story: { digest: string } } }).value.story.digest;
      expect(digest).toContain("   Asked: Approve the release notes");
      expect(digest).toContain("   Asked: Which channel ships it?");
    });

    it("names a loaded run's branch and each Agent stage's instructions from the stored manifest in its digest", async () => {
      const { runs, runId } = seededRun(
        onWorkspaceMainFlow(
          [
            agent("s1", { settings: { instructions: "Draft the release notes from merged PRs." } }),
            agent("s2", { settings: { instructions: "Post the notes to the release channel." } }),
          ],
          [thenWire("s1", "s2")],
        ),
      );
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      const loaded = await handler.handle({ id: 1, type: "load-run", payload: { runId } });

      expect((loaded as { error?: string }).error).toBeUndefined();
      const digest = (loaded as { value: { story: { digest: string } } }).value.story.digest;
      expect(digest).toContain("Repo: /repo\nBranch: flowdeck/report\n");
      expect(digest).toContain("Instructions: Draft the release notes from merged PRs.");
      expect(digest).toContain("Instructions: Post the notes to the release channel.");
    });

    it("answers a run's pipeline in run order from the stored manifest and its events, reading no blueprint", async () => {
      const { runs, runId } = seededRun();
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      const answered = await handler.handle({
        id: 1,
        type: "run-pipeline" as never,
        payload: { runId },
      });

      expect(answered).toMatchObject({ id: 1, ok: true });
      const stages =
        (answered as { value: { items: { nodeId: string; label: string; status: string }[] }[] })
          .value[0]?.items ?? [];
      expect(stages.map(({ nodeId, label, status }) => ({ nodeId, label, status }))).toEqual([
        { nodeId: "start", label: "start", status: "waiting" },
        { nodeId: "s1", label: "Plan", status: "done" },
        { nodeId: "s2", label: "Ship", status: "waiting" },
        { nodeId: "stop", label: "stop", status: "waiting" },
      ]);
    });

    it("answers a run's pipeline without its activity, while the run's story still lists each stage's steps", async () => {
      const { runs, runId } = seededRun(
        onWorkspaceMainFlow(
          [{ ...agent("s1"), label: "Plan" }, loop("rounds"), agent("body", { parent: "rounds" })],
          [thenWire("s1", "rounds")],
        ),
        ["s1", "rounds", "body"],
      );
      runs.append(runId, "rounds", { kind: "running" });
      runs.append(runId, "rounds", { kind: "round", payload: { round: 1 } });
      runs.append(runId, "body", { kind: "sent" });
      runs.append(runId, "body", { kind: "done" });
      runs.append(runId, "rounds", { kind: "round", payload: { round: 2 } });
      runs.append(runId, "body", { kind: "reset" });
      runs.append(runId, "body", { kind: "sent" });
      for (const [id, nodeId] of [
        [1, "s1"],
        [2, "body"],
      ] as const)
        runs.recordActivity(runId, {
          id,
          nodeId,
          at: 0,
          summary: `step of ${nodeId}`,
          kind: "tool",
          tool: "Read",
          result: "ok",
        });
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      const answered = await handler.handle({ id: 1, type: "run-pipeline", payload: { runId } });

      type Stage = {
        nodeId: string;
        activity: unknown[];
        activityFrom?: number;
        activityTo?: number;
        rounds?: { round: number; items: Stage[] }[];
      };
      const stagesOf = (items: Stage[]): Stage[] =>
        items.flatMap((stage) => [
          stage,
          ...(stage.rounds ?? []).flatMap((round) => stagesOf(round.items)),
        ]);
      const stages = stagesOf(
        (answered as { value: { items: Stage[] }[] }).value.flatMap((group) => group.items),
      );
      expect(stages.map((stage) => stage.nodeId)).toEqual(
        expect.arrayContaining(["s1", "rounds", "body"]),
      );
      expect(stages.flatMap((stage) => stage.activity)).toEqual([]);
      const bodies = stages.filter((stage) => stage.nodeId === "body");
      expect(bodies.map(({ activityFrom, activityTo }) => ({ activityFrom, activityTo }))).toEqual([
        { activityFrom: undefined, activityTo: expect.any(Number) },
        { activityFrom: expect.any(Number), activityTo: undefined },
      ]);
      const loaded = await handler.handle({ id: 2, type: "load-run", payload: { runId } });
      const { digest } = (loaded as { value: { story: { digest: string } } }).value.story;
      expect(digest).toContain("Read step of s1 → ok");
      expect(digest).toContain("Read step of body → ok");
    });

    it("refuses the pipeline of an unknown run", async () => {
      const { runs } = seededRun();
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      expect(
        await handler.handle({ id: 1, type: "run-pipeline" as never, payload: { runId: "nope" } }),
      ).toEqual({ id: 1, ok: false, error: "No run nope" });
    });

    describe("a run outlives its build", () => {
      const askedFlow = () =>
        onWorkspaceMainFlow(
          [
            { ...agent("s1"), label: "Plan" },
            gate("s2", { settings: { shown: "Approve the release notes", skippable: false } }),
            ask("s3", { settings: { question: "Which channel ships it?", options: ["a", "b"] } }),
          ],
          [thenWire("s1", "s2"), thenWire("s2", "s3")],
        );

      const finishedRun = () => {
        const seeded = seededRun(askedFlow(), ["s1", "s2", "s3"]);
        seeded.runs.append(seeded.runId, "s1", {
          kind: "usage",
          payload: { messages: [] },
          tokens: 40,
          cost: 0.12,
        });
        seeded.runs.appendRunStory({
          runId: seeded.runId,
          at: "2026-11-17T00:00:00.000Z",
          runStatus: "failed",
          text: "It planned, then stopped.",
          cost: 0.01,
        });
        return seeded;
      };

      const readersOf = (runs: FakeStore, runId: string) => {
        const handler = createEngineHandler(
          options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
        );
        return async () => ({
          listed: await handler.handle({ id: 1, type: "list-runs" }),
          loaded: await handler.handle({ id: 2, type: "load-run", payload: { runId } }),
          cost: await handler.handle({ id: 3, type: "run-cost", payload: { runId } }),
          pipeline: await handler.handle({
            id: 4,
            type: "run-pipeline" as never,
            payload: { runId },
          }),
        });
      };

      it("shows a finished run of a deleted build with what it showed before, reading no blueprint", async () => {
        const { runs, runId } = finishedRun();
        const read = readersOf(runs, runId);
        const before = await read();
        expect(before.loaded).toMatchObject({
          ok: true,
          value: {
            run: { id: runId, buildGone: false },
            name: "report",
            stages: { nodes: expect.arrayContaining([expect.objectContaining({ id: "s3" })]) },
            story: {
              header: { name: "report", blueprintName: "Report", blueprintVersion: 1 },
              digest: expect.stringContaining("   Asked: Which channel ships it?"),
              written: { text: "It planned, then stopped." },
            },
          },
        });
        expect(before.cost).toMatchObject({ ok: true, value: { total: { tokens: 40 } } });
        expect(before.pipeline).toMatchObject({ ok: true, value: expect.any(Array) });

        runs.deleteBuild("b1");
        const after = await read();

        expect(runs.findBuild("b1")).toBeUndefined();
        expect(after.listed).toEqual({
          id: 1,
          ok: true,
          value: [{ ...(before.listed as { value: object[] }).value[0], buildGone: true }],
        });
        const loadedBefore = (before.loaded as { value: { run: object } }).value;
        expect(after.loaded).toEqual({
          ...before.loaded,
          value: { ...loadedBefore, run: { ...loadedBefore.run, buildGone: true } },
        });
        expect(after.cost).toEqual(before.cost);
        expect(after.pipeline).toEqual(before.pipeline);
      });

      it("lists each gate and ask question of a deleted build's run in its digest", async () => {
        const { runs, runId } = finishedRun();
        runs.deleteBuild("b1");

        const { loaded } = await readersOf(runs, runId)();

        expect(loaded).toMatchObject({
          ok: true,
          value: {
            story: {
              header: {
                name: "report",
                blueprintName: "Report",
                blueprintVersion: 1,
                repo: "/repo",
                values: {},
              },
              digest: expect.stringContaining("Build: report"),
            },
          },
        });
        const { digest } = (loaded as { value: { story: { digest: string } } }).value.story;
        expect(digest).toContain("   Asked: Approve the release notes");
        expect(digest).toContain("   Asked: Which channel ships it?");
      });

      it("answers a deleted build's run its stages, pipeline and per-stage cost", async () => {
        const { runs, runId } = finishedRun();
        runs.deleteBuild("b1");

        const { loaded, cost, pipeline } = await readersOf(runs, runId)();

        expect(loaded).toMatchObject({
          ok: true,
          value: {
            stages: {
              session: { name: "workspace" },
              nodes: [
                { id: "start", type: "trigger" },
                { id: "s1", type: "agent", label: "Plan" },
                { id: "s2", type: "gate" },
                { id: "s3", type: "ask" },
                { id: "stop", type: "output" },
              ],
            },
          },
        });
        expect(
          (
            pipeline as { value: { items: { nodeId: string; status: string }[] }[] | null }
          ).value?.[0]?.items.map(({ nodeId, status }) => ({ nodeId, status })),
        ).toEqual([
          { nodeId: "start", status: "waiting" },
          { nodeId: "s1", status: "done" },
          { nodeId: "s2", status: "waiting" },
          { nodeId: "s3", status: "waiting" },
          { nodeId: "stop", status: "waiting" },
        ]);
        expect(cost).toEqual({
          id: 3,
          ok: true,
          value: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({ nodeId: "s1", tokens: 40, cost: 0.12 }),
            ]),
            total: expect.objectContaining({ tokens: 40, cost: 0.12 }),
          }),
        });
      });
    });

    it("shows a run left running by an earlier session as interrupted, in the list and on its own", async () => {
      const { flows, runs } = seededRun();
      const { id: stale } = runs.createRun({
        buildDir: "/fd-home/workspaces/b1",
        inputs: {},
        nodeIds: ["s1", "s2"],
        session: {
          tmuxName: "fd-run-y",
          cwd: "/fd-home/workspaces/b1/repo",
          claudeSessionId: "c2",
        },
        buildId: "b1",
      });
      runs.append(stale, "s1", { kind: "sent" });
      const handler = createEngineHandler(options({ openStores: () => ({ runs, flows }) }));

      expect(await handler.handle({ id: 1, type: "list-runs" })).toMatchObject({
        value: [{ id: stale, status: "interrupted", endedAt: null }, { status: "failed" }],
      });
      expect(await handler.handle({ id: 2, type: "load-run", payload: { runId: stale } })).toEqual({
        id: 2,
        ok: true,
        value: expect.objectContaining({
          run: expect.objectContaining({ id: stale, status: "interrupted" }),
          snapshot: { runId: stale, status: "interrupted", nodes: { s1: "sent", s2: "waiting" } },
        }),
      });
      expect(runs.findRun(stale)?.status).toBe("running");
    });

    describe("step-full-text", () => {
      const handlerOn = (runs: FakeStore) =>
        createEngineHandler(options({ openStores: () => ({ runs, flows: unreadableFlows() }) }));

      const fullTextOf = (runs: FakeStore, payload: unknown) =>
        handlerOn(runs).handle({ id: 7, type: "step-full-text", payload });

      it("answers the kept full text of a cut step, the latest one per field", async () => {
        const { runs, runId } = seededRun();
        runs.appendStepText(runId, 3, "output", "first full output");
        runs.appendStepText(runId, 3, "output", `${"x".repeat(5000)}END-OF-FULL-OUTPUT`);
        runs.appendStepText(runId, 3, "input", "full input");
        runs.appendStepText(runId, 4, "report", "another step's report");

        expect(await fullTextOf(runs, { runId, entryId: 3 })).toEqual({
          id: 7,
          ok: true,
          value: {
            kept: true,
            texts: { input: "full input", output: `${"x".repeat(5000)}END-OF-FULL-OUTPUT` },
          },
        });
      });

      it("answers that the full text was not kept for a step with no stored text", async () => {
        const { runs, runId } = seededRun();
        runs.appendStepText(runId, 3, "output", "kept");

        expect(await fullTextOf(runs, { runId, entryId: 4 })).toEqual({
          id: 7,
          ok: true,
          value: { kept: false },
        });
      });

      it.each([
        ["no entry id", {}],
        ["an entry id that is not a whole number", { entryId: 1.5 }],
        ["an entry id that is text", { entryId: "3" }],
        ["no run id", { runId: undefined, entryId: 3 }],
      ])("refuses a payload with %s", async (_label, fields) => {
        const { runs, runId } = seededRun();
        runs.appendStepText(runId, 3, "output", "kept");

        expect(await fullTextOf(runs, { runId, ...fields })).toEqual({
          id: 7,
          ok: false,
          error: expect.stringContaining("invalid_type"),
        });
      });

      it("answers a deleted run and an unknown run the way loading them does", async () => {
        const { runs, runId } = seededRun();
        runs.appendStepText(runId, 3, "output", "kept");
        runs.deleteRun(runId);

        expect(
          await handlerOn(runs).handle({ id: 6, type: "load-run", payload: { runId } }),
        ).toEqual({ id: 6, ok: false, error: `No run ${runId}` });
        expect(await fullTextOf(runs, { runId, entryId: 3 })).toEqual({
          id: 7,
          ok: false,
          error: `No run ${runId}`,
        });
        expect(
          await handlerOn(runs).handle({ id: 6, type: "load-run", payload: { runId: "nope" } }),
        ).toEqual({ id: 6, ok: false, error: "No run nope" });
        expect(await fullTextOf(runs, { runId: "nope", entryId: 3 })).toEqual({
          id: 7,
          ok: false,
          error: "No run nope",
        });
      });
    });

    describe("build-step-full-text", () => {
      const pendingStore = () => {
        const runs = new FakeStore();
        const started = runs.startPendingBuild({
          flowId: "flow-a",
          version: 1,
          name: "report",
          origin: {
            source: { flowId: "flow-a", version: 1 },
            blueprint: { name: "Report", version: 1 },
          },
          startedAt: 1_000,
          snapshot: { blueprintName: "Report", version: 1, svg: "<svg/>" },
        });
        if (started.kind !== "started") throw new Error("the pending build did not start");
        return { runs, pendingId: started.pendingId };
      };

      const buildFullTextOf = (runs: FakeStore, payload: unknown) =>
        createEngineHandler(
          options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
        ).handle({ id: 8, type: "build-step-full-text", payload });

      it("answers the kept full text of a cut build step, the latest one per field", async () => {
        const { runs, pendingId } = pendingStore();
        runs.appendBuildStepText(pendingId, 3, "output", "first full output");
        runs.appendBuildStepText(pendingId, 3, "output", `${"x".repeat(5000)}END`);
        runs.appendBuildStepText(pendingId, 3, "report", "full report");
        runs.appendBuildStepText(pendingId, 4, "input", "another step's input");

        expect(await buildFullTextOf(runs, { pendingId, entryId: 3 })).toEqual({
          id: 8,
          ok: true,
          value: {
            kept: true,
            texts: { output: `${"x".repeat(5000)}END`, report: "full report" },
          },
        });
      });

      it("answers that the full text was not kept for a build step with no stored text", async () => {
        const { runs, pendingId } = pendingStore();
        runs.appendBuildStepText(pendingId, 3, "output", "kept");

        expect(await buildFullTextOf(runs, { pendingId, entryId: 4 })).toEqual({
          id: 8,
          ok: true,
          value: { kept: false },
        });
      });

      it("refuses an unknown pending build, naming it", async () => {
        const { runs } = pendingStore();

        expect(await buildFullTextOf(runs, { pendingId: "nope", entryId: 3 })).toEqual({
          id: 8,
          ok: false,
          error: "No pending build nope",
        });
      });

      it.each([
        ["no entry id", {}],
        ["an entry id that is not a whole number", { entryId: 1.5 }],
        ["an entry id that is text", { entryId: "3" }],
        ["no pending id", { pendingId: undefined, entryId: 3 }],
      ])("refuses a payload with %s", async (_label, fields) => {
        const { runs, pendingId } = pendingStore();
        runs.appendBuildStepText(pendingId, 3, "output", "kept");

        expect(await buildFullTextOf(runs, { pendingId, ...fields })).toEqual({
          id: 8,
          ok: false,
          error: expect.stringContaining("invalid_type"),
        });
      });
    });
  });

  describe("build-picture", () => {
    const pictured = () => onWorkspaceMainFlow([agent("draw")], []);

    const pictureStores = () => {
      const runs = new FakeStore();
      runs.recordBuild({
        id: "b1",
        hash: "h1",
        name: "pictured",
        repo: "/repo",
        base: "main",
        branch: "flowdeck/pictured",
        branchCreated: true,
        values: {},
        dir: "/fd-home/workspaces/b1",
        source: { flowId: "flow-a", version: 1 },
        files: [],
        nodes: [],
        manifest: "{}",
      });
      const pictured1 = runs.startPendingBuild({
        flowId: "flow-a",
        version: 1,
        name: "pictured",
        origin: {
          source: { flowId: "flow-a", version: 1 },
          blueprint: { name: "Report", version: 1 },
        },
        startedAt: 0,
        snapshot: { blueprintName: "Report", version: 1, svg: flowSvg(pictured()) },
      });
      if (pictured1.kind !== "started") throw new Error("the pending build did not start");
      runs.endPendingBuild(pictured1.pendingId, { outcome: "built", endedAt: 1, buildId: "b1" });
      runs.recordBuild({
        id: "b2",
        hash: "h2",
        name: "flow-less",
        repo: "/repo",
        base: "main",
        branch: "flowdeck/flow-less",
        branchCreated: true,
        values: {},
        dir: "/fd-home/workspaces/b2",
        files: [],
        nodes: [],
        manifest: "{}",
      });
      const going = runs.startPendingBuild({
        flowId: "flow-a",
        version: 2,
        name: "going",
        origin: {
          source: { flowId: "flow-a", version: 2 },
          blueprint: { name: "Report", version: 2 },
        },
        startedAt: 1_000,
        snapshot: {
          blueprintName: "Report",
          version: 2,
          svg: "<svg>going</svg>",
        },
      });
      if (going.kind !== "started") throw new Error("the pending build did not start");
      return { runs, pendingId: going.pendingId };
    };

    const picture = (
      handler: ReturnType<typeof createEngineHandler>,
      id: number,
      payload: unknown,
    ) => handler.handle({ id, type: "build-picture" as never, payload });

    it("answers a build's picture and a pending build's picture from their snapshots, reading no blueprint", async () => {
      const { runs, pendingId } = pictureStores();
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      expect(await picture(handler, 1, { buildId: "b1" })).toEqual({
        id: 1,
        ok: true,
        value: { svg: flowSvg(pictured()) },
      });
      expect(await picture(handler, 2, { pendingId })).toEqual({
        id: 2,
        ok: true,
        value: { svg: "<svg>going</svg>" },
      });
    });

    it("answers no picture for a flow-less build and an unknown one", async () => {
      const { runs } = pictureStores();
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      expect(await picture(handler, 1, { buildId: "b2" })).toEqual({
        id: 1,
        ok: true,
        value: { svg: null },
      });
      expect(await picture(handler, 2, { buildId: "nope" })).toEqual({
        id: 2,
        ok: true,
        value: { svg: null },
      });
      expect(await picture(handler, 3, { pendingId: "nope" })).toEqual({
        id: 3,
        ok: true,
        value: { svg: null },
      });
    });
  });

  describe("a clean start after the upgrade that wiped every build and run", () => {
    const home = "/fd-home";
    const wiped = { applied: ["022_clean_start"], existedBefore: true };
    const leftBehind = [
      `${home}/workspaces/b1/manifest.json`,
      `${home}/runs/r1/mcp.json`,
      `${home}/build-sessions/fd-build-a/settings.json`,
      `${home}/worktrees/fix-login/README.md`,
    ];
    const kept = [`${home}/bp-sessions/flow-1/settings.json`, `${home}/hooks/flowdeck-hook.cjs`];

    const homeWith = (...paths: string[]) =>
      new FakeFileSystem(Object.fromEntries(paths.map((path) => [path, "x"])));

    const startedWith = async (
      fs: FakeFileSystem,
      migrations: { applied: string[]; existedBefore: boolean },
      overrides: Partial<EngineHandlerOptions> = {},
    ) => {
      const handler = createEngineHandler(
        options({ home, fs, openStores: () => ({ ...stores(), migrations }), ...overrides }),
      );
      await handler.startUp();
    };

    const present = async (fs: FakeFileSystem, paths: string[]) =>
      (
        await Promise.all(paths.map(async (path) => ((await fs.exists(path)) ? [path] : [])))
      ).flat();

    it("removes the build and run folders under the home when this open applied it to an existing database", async () => {
      const fs = homeWith(...leftBehind, ...kept);

      await startedWith(fs, wiped);

      expect(await present(fs, leftBehind)).toEqual([]);
      expect(await present(fs, kept)).toEqual(kept);
    });

    it.each([
      [["023_containers_clean_start"]],
      [["022_clean_start", "023_containers_clean_start"]],
    ])("removes them too when this open applied %j", async (applied) => {
      const fs = homeWith(...leftBehind, ...kept);

      await startedWith(fs, { applied, existedBefore: true });

      expect(await present(fs, leftBehind)).toEqual([]);
      expect(await present(fs, kept)).toEqual(kept);
    });

    it("removes nothing when this open applied migrations but no clean start", async () => {
      const fs = homeWith(...leftBehind);

      await startedWith(fs, {
        applied: ["021_complete_deletes_and_build_texts"],
        existedBefore: true,
      });

      expect(await present(fs, leftBehind)).toEqual(leftBehind);
    });

    it("removes nothing on a database this open created", async () => {
      const fs = homeWith(...leftBehind);

      await startedWith(fs, {
        applied: ["021_complete_deletes_and_build_texts", "022_clean_start"],
        existedBefore: false,
      });

      expect(await present(fs, leftBehind)).toEqual(leftBehind);
    });

    it("removes nothing on the start after the one that applied it", async () => {
      const fs = homeWith(...leftBehind);
      await startedWith(fs, wiped);
      const madeSince = `${home}/workspaces/b2/manifest.json`;
      await fs.writeFile(madeSince, "x");

      await startedWith(fs, { applied: [], existedBefore: true });

      expect(await fs.exists(madeSince)).toBe(true);
    });

    it("removes nothing while another Flowdeck holds the home", async () => {
      const fs = homeWith(...leftBehind);

      await startedWith(fs, wiped, { homeLock: { acquire: async () => false } });

      expect(await present(fs, leftBehind)).toEqual(leftBehind);
    });

    const tmuxWith = (sockets: Record<string, string | Error>) => {
      const ended: string[] = [];
      const overrides: Partial<EngineHandlerOptions> = {
        flowdeckSessions: async () => Object.keys(sockets),
        sessionSocketPath: async (name) => {
          const socket = sockets[name];
          if (socket instanceof Error) throw socket;
          return socket;
        },
        endSession: async (name) => {
          ended.push(name);
        },
      };
      return { ended, overrides };
    };

    it("ends a tmux session of this home that the wiped runs left behind", async () => {
      const tmux = tmuxWith({ "fd-run-own": `${home}/sockets/fd-run-own.sock` });

      await startedWith(homeWith(...leftBehind), wiped, tmux.overrides);

      expect(tmux.ended).toEqual(["fd-run-own"]);
    });

    it("leaves a session of another home alone", async () => {
      const tmux = tmuxWith({
        "fd-run-own": `${home}/sockets/fd-run-own.sock`,
        "fd-run-other": "/fd-home2/sockets/fd-run-other.sock",
      });

      await startedWith(homeWith(...leftBehind), wiped, tmux.overrides);

      expect(tmux.ended).toEqual(["fd-run-own"]);
    });

    it("leaves a session alone whose socket folder only begins with this home's sockets folder name", async () => {
      const tmux = tmuxWith({
        "fd-run-own": `${home}/sockets/fd-run-own.sock`,
        "fd-run-sibling": `${home}/sockets2/x.sock`,
      });

      await startedWith(homeWith(...leftBehind), wiped, tmux.overrides);

      expect(tmux.ended).toEqual(["fd-run-own"]);
    });

    it("leaves alone a session of this home that starts after the start-up began", async () => {
      const tmux = tmuxWith({
        "fd-run-own": `${home}/sockets/fd-run-own.sock`,
        "fd-bp-late": `${home}/sockets/bp.sock`,
      });
      const running = ["fd-run-own"];
      const handler = createEngineHandler(
        options({
          home,
          fs: homeWith(...leftBehind),
          openStores: () => ({ ...stores(), migrations: wiped }),
          ...tmux.overrides,
          flowdeckSessions: async () => [...running],
        }),
      );

      const startingUp = handler.startUp();
      running.push("fd-bp-late");
      await startingUp;

      expect(tmux.ended).toEqual(["fd-run-own"]);
    });

    it("ends a session whose socket path reaches this home through a link", async () => {
      const fs = homeWith(...leftBehind);
      fs.link("/linked-home", home);
      const tmux = tmuxWith({ "fd-run-own": "/linked-home/sockets/fd-run-own.sock" });

      await startedWith(fs, wiped, tmux.overrides);

      expect(tmux.ended).toEqual(["fd-run-own"]);
    });

    it("ends nothing and removes the folders as before when no session is left", async () => {
      const fs = homeWith(...leftBehind, ...kept);
      const tmux = tmuxWith({});

      await startedWith(fs, wiped, tmux.overrides);

      expect(tmux.ended).toEqual([]);
      expect(await present(fs, leftBehind)).toEqual([]);
      expect(await present(fs, kept)).toEqual(kept);
    });

    it("still ends the other sessions and removes the folders when one session cannot be read", async () => {
      const fs = homeWith(...leftBehind);
      const tmux = tmuxWith({
        "fd-run-stale": new Error("no server running on /tmp/tmux-502/fd-run-stale"),
        "fd-run-own": `${home}/sockets/fd-run-own.sock`,
      });

      await startedWith(fs, wiped, tmux.overrides);

      expect(tmux.ended).toEqual(["fd-run-own"]);
      expect(await present(fs, leftBehind)).toEqual([]);
    });

    it("still removes the folders when the sessions cannot be listed", async () => {
      const fs = homeWith(...leftBehind);
      const tmux = tmuxWith({ "fd-run-own": `${home}/sockets/fd-run-own.sock` });

      await startedWith(fs, wiped, {
        ...tmux.overrides,
        flowdeckSessions: () => Promise.reject(new Error("permission denied")),
      });

      expect(tmux.ended).toEqual([]);
      expect(await present(fs, leftBehind)).toEqual([]);
    });

    it("ends no session while another Flowdeck holds the home", async () => {
      const tmux = tmuxWith({ "fd-run-own": `${home}/sockets/fd-run-own.sock` });

      await startedWith(homeWith(...leftBehind), wiped, {
        ...tmux.overrides,
        homeLock: { acquire: async () => false },
      });

      expect(tmux.ended).toEqual([]);
    });

    describe("on real git", () => {
      const committer = [
        "-c",
        "user.name=Flowdeck Test",
        "-c",
        "user.email=test@flowdeck.invalid",
        "-c",
        "commit.gpgsign=false",
      ];
      const gitIn = async (folder: string, ...args: string[]) =>
        (await promisify(execFile)("git", ["-C", folder, ...args])).stdout;
      const registered = async (repo: string) =>
        (await gitIn(repo, "worktree", "list", "--porcelain"))
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length));
      const branchesOf = (repo: string) =>
        gitIn(repo, "branch", "--list", "--format=%(refname:short)");

      let realHome: string;
      let outside: string;
      let repo: string;
      const git = new GitWorktree();

      beforeEach(async () => {
        realHome = await realpath(await mkdtemp(join(tmpdir(), "fd-clean-home-")));
        outside = await realpath(await mkdtemp(join(tmpdir(), "fd-clean-outside-")));
        const made = await createTmpRepo({ commit: true });
        repo = made.path;
      });

      afterEach(async () => {
        await rm(realHome, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
        await rm(repo, { recursive: true, force: true });
      });

      const addOn = (branch: string, path: string, create = true) =>
        git.add({ repo, base: "main", branch, path, create });

      const startedAtRealHome = async (home = realHome) => {
        const handler = createEngineHandler(
          options({
            home,
            fs: new NodeFileSystem(),
            openStores: () => ({ ...stores(), migrations: wiped }),
            worktree: git,
            gitState: new GitFolderState(),
          }),
        );
        await handler.startUp();
      };

      it("unregisters the Flowdeck worktrees it deletes and their flowdeck branches, leaving the user's worktree and branch alone", async () => {
        await addOn("flowdeck/b1", sessionWorktree(workspaceDir(realHome, "b1"), "s", repo));
        await addOn("flowdeck/b2", join(realHome, "workspaces", "b2", basename(repo)));
        await addOn("flowdeck/abcd1234", join(realHome, "worktrees", "abcd1234"));
        await addOn("user/wt", join(outside, "wt"));
        await gitIn(repo, "branch", "user/keep");
        await gitIn(repo, "worktree", "add", "--detach", join(outside, "gone"));
        await rm(join(outside, "gone"), { recursive: true, force: true });

        await startedAtRealHome();

        expect((await registered(repo)).sort()).toEqual(
          [repo, join(outside, "gone"), join(outside, "wt")].sort(),
        );
        expect(await branchesOf(repo)).toBe("main\nuser/keep\nuser/wt\n");
      });

      it("keeps a flowdeck branch that holds commits found nowhere else", async () => {
        const path = sessionWorktree(workspaceDir(realHome, "b1"), "s", repo);
        await addOn("flowdeck/b1", path);
        await writeFile(join(path, "made.txt"), "made\n");
        await gitIn(path, "add", "made.txt");
        await gitIn(path, ...committer, "commit", "--quiet", "-m", "made");

        await startedAtRealHome();

        expect(await registered(repo)).toEqual([repo]);
        expect(await branchesOf(repo)).toBe("flowdeck/b1\nmain\n");
      });

      it("keeps a branch not named flowdeck/ that a Flowdeck worktree held", async () => {
        await gitIn(repo, "branch", "test/syncer-build");
        await addOn(
          "test/syncer-build",
          sessionWorktree(workspaceDir(realHome, "b1"), "s", repo),
          false,
        );

        await startedAtRealHome();

        expect(await registered(repo)).toEqual([repo]);
        expect(await branchesOf(repo)).toBe("main\ntest/syncer-build\n");
      });

      it("unregisters the Flowdeck worktrees when the home is reached through a symlink", async () => {
        const linkedHome = join(outside, "home");
        await symlink(realHome, linkedHome);
        await addOn("flowdeck/b1", sessionWorktree(workspaceDir(realHome, "b1"), "s", repo));
        await addOn("flowdeck/abcd1234", join(realHome, "worktrees", "abcd1234"));

        await startedAtRealHome(linkedHome);

        expect(await registered(repo)).toEqual([repo]);
        expect(await branchesOf(repo)).toBe("main\n");
      });

      it("leaves alone a user's worktree that a symlink under the home leads to", async () => {
        const users = join(outside, "wt");
        await addOn("user/wt", users);
        await writeFile(join(users, "mine.txt"), "mine\n");
        await symlink(outside, join(realHome, "worktrees"));

        await startedAtRealHome();

        expect((await registered(repo)).sort()).toEqual([repo, users].sort());
        expect(await readFile(join(users, "mine.txt"), "utf8")).toBe("mine\n");
        expect(await branchesOf(repo)).toBe("main\nuser/wt\n");
      });

      it("leaves alone a user's worktree inside the home that a symlink under the home leads to", async () => {
        const users = join(realHome, "mine", "wt");
        await addOn("user/wt", users);
        await writeFile(join(users, "mine.txt"), "mine\n");
        await symlink(join(realHome, "mine"), join(realHome, "worktrees"));

        await startedAtRealHome();

        expect((await registered(repo)).sort()).toEqual([repo, users].sort());
        expect(await readFile(join(users, "mine.txt"), "utf8")).toBe("mine\n");
        expect(await branchesOf(repo)).toBe("main\nuser/wt\n");
      });

      it("unregisters a Flowdeck worktree of a bare repo", async () => {
        const bare = join(outside, "bare.git");
        await promisify(execFile)("git", ["clone", "--quiet", "--bare", repo, bare]);
        await gitIn(
          bare,
          "worktree",
          "add",
          "-b",
          "flowdeck/b1",
          join(realHome, "workspaces", "b1", "bare"),
          "main",
        );

        await startedAtRealHome();

        expect(await registered(bare)).toEqual([bare]);
        expect(await branchesOf(bare)).toBe("main\n");
      });
    });

    const seeded = (worktree: FakeWorktree, held: Record<string, [string, string]>) => {
      for (const [path, [repo, branch]] of Object.entries(held)) {
        worktree.worktrees.set(path, { repo, base: "main", branch });
      }
      return homeWith(...Object.keys(held).map((path) => `${path}/README.md`));
    };

    it("reads each worktree's checkout before the folders are removed", async () => {
      const read: [string, boolean][] = [];
      let fs = new FakeFileSystem();
      const worktree = new (class extends FakeWorktree {
        override async checkoutAt(path: string) {
          read.push([path, await fs.exists(path)]);
          return super.checkoutAt(path);
        }
      })();
      const v12 = `${home}/workspaces/b1/sessions/s/repo`;
      const v11 = `${home}/workspaces/b2/repo`;
      const old = `${home}/worktrees/abcd1234`;
      fs = seeded(worktree, {
        [v12]: ["/repo", "flowdeck/b1"],
        [v11]: ["/repo", "flowdeck/b2"],
        [old]: ["/repo", "flowdeck/abcd1234"],
      });

      await startedWith(fs, wiped, { worktree });

      expect(read).toEqual(
        expect.arrayContaining([
          [v12, true],
          [v11, true],
          [old, true],
        ]),
      );
    });

    it("clears the other repos and still removes the folders when one repo fails", async () => {
      const worktree = new (class extends FakeWorktree {
        override async remove(options: WorktreeRemoveOptions) {
          if (options.repo === "/repo-a") throw new Error("index.lock exists");
          return super.remove(options);
        }
      })();
      const pathA = `${home}/workspaces/a/repo-a`;
      const pathB = `${home}/workspaces/b/repo-b`;
      const fs = seeded(worktree, {
        [pathA]: ["/repo-a", "flowdeck/a"],
        [pathB]: ["/repo-b", "flowdeck/b"],
      });

      await startedWith(fs, wiped, { worktree });

      expect(worktree.removed.map(({ path }) => path)).toEqual([pathB]);
      expect(worktree.deletedBranches).toEqual([{ repo: "/repo-b", branch: "flowdeck/b" }]);
      expect(await present(fs, [`${pathA}/README.md`, `${pathB}/README.md`])).toEqual([]);
    });

    it("keeps a flowdeck branch another worktree still has checked out", async () => {
      const worktree = new FakeWorktree();
      const path = `${home}/workspaces/b2/repo`;
      const fs = seeded(worktree, { [path]: ["/repo", "flowdeck/b2"] });

      await startedWith(fs, wiped, {
        worktree,
        gitState: new FakeGitState(
          {},
          { checkedOut: { "/repo": { "flowdeck/b2": "/elsewhere" } } },
        ),
      });

      expect(worktree.removed.map(({ path: removed }) => removed)).toEqual([path]);
      expect(worktree.deletedBranches).toEqual([]);
    });

    it("touches no worktree when another process holds the home", async () => {
      const read: string[] = [];
      const worktree = new (class extends FakeWorktree {
        override async checkoutAt(path: string) {
          read.push(path);
          return super.checkoutAt(path);
        }
      })();
      const fs = seeded(worktree, { [`${home}/workspaces/b2/repo`]: ["/repo", "flowdeck/b2"] });

      await startedWith(fs, wiped, { worktree, homeLock: { acquire: async () => false } });

      expect(read).toEqual([]);
      expect(worktree.removed).toEqual([]);
    });

    it("still removes the folders and ends the sessions when a folder of the home cannot be read", async () => {
      const fs = new (class extends FakeFileSystem {
        override async folders(dir: string) {
          if (dir === `${home}/workspaces/b1/sessions`)
            throw new Error("EACCES: permission denied");
          return super.folders(dir);
        }
      })(Object.fromEntries(leftBehind.map((path) => [path, "x"])));
      const tmux = tmuxWith({ "fd-run-own": `${home}/sockets/fd-run-own.sock` });

      await startedWith(fs, wiped, tmux.overrides);

      expect(await present(fs, leftBehind)).toEqual([]);
      expect(tmux.ended).toEqual(["fd-run-own"]);
    });
  });

  describe("doctor", () => {
    it("reports the installed connectors from a request with no payload, without any setting's value", async () => {
      const handler = createEngineHandler(
        options({
          connectors: new FakeConnectorSource({
            jira,
            slack: { command: "slack-mcp", env: { SLACK_TOKEN: "xoxb-secret" } },
          }),
        }),
      );

      const answer = await handler.handle({ id: 1, type: "doctor" });

      expect(answer).toEqual({
        id: 1,
        ok: true,
        value: {
          installed: [
            { name: "jira", status: "ok", settings: [] },
            { name: "slack", status: "ok", settings: [{ name: "SLACK_TOKEN", set: true }] },
          ],
        },
      });
      expect(JSON.stringify(answer)).not.toContain("xoxb-secret");
    });

    it("answers a connector source that cannot be read as an error", async () => {
      const connectors = new FakeConnectorSource();
      connectors.list = () => Promise.reject(new Error("~/.claude.json is not valid JSON"));
      const handler = createEngineHandler(options({ connectors }));

      expect(await handler.handle({ id: 1, type: "doctor" })).toEqual({
        id: 1,
        ok: false,
        error: "~/.claude.json is not valid JSON",
      });
    });
  });

  describe("run-build", () => {
    let home: string;
    let repo: TmpRepo;
    let runs: FakeStore;
    let flows: FakeFlowStore;
    let pushes: EnginePush[];
    let handler: ReturnType<typeof createEngineHandler>;
    let nextId: number;
    let names: number;

    const inFolder = (input: Flow, { repo, base }: { repo?: string; base?: string }): Flow => ({
      ...input,
      containers: input.containers.map((container) =>
        container.kind === "session"
          ? { ...container, repo: repo ?? "", branch: base ?? container.branch }
          : container,
      ),
    });

    const atRepo = (input: Flow): Flow => inFolder(input, { repo: repo.path });

    const twoAgents = () =>
      atRepo(onWorkspaceMainFlow([agent("write"), agent("check")], [thenWire("write", "check")]));

    const sleeper = () => atRepo(onWorkspaceMainFlow([agent("nap")], []));

    const collectInto = (sink: EnginePush[]) => (push: EnginePush) => {
      sink.push(push);
    };

    const handlerWith = (overrides: Partial<EngineHandlerOptions> = {}) =>
      createEngineHandler(
        options({
          openStores: () => ({ runs, flows }),
          home,
          publish: collectInto(pushes),
          prepareHooks: () => ({
            kind: "ok",
            nodePath: process.execPath,
            hookScriptPath: `${home}/hooks/flowdeck-hook.cjs`,
            guardScriptPath: `${home}/hooks/flowdeck-build-guard.cjs`,
            webGuardScriptPath: `${home}/hooks/flowdeck-web-guard.cjs`,
          }),
          gitState: gitAt(repo.path),
          ...overrides,
        }),
      );

    type Started = { kind: "started"; runId: string } | { kind: "error"; message: string };

    type Built =
      { kind: "built"; id: string } | { kind: "error"; message: string; problems?: unknown[] };

    type BuildAnswer =
      | { kind: "started"; pendingId: string }
      | { kind: "error"; message: string; problems?: unknown[] };

    const buildEnd = (pendingId: string) =>
      vi.waitFor(
        () => {
          const ended = pushes.findLast(
            (push): push is Extract<EnginePush, { push: "build-progress" }> =>
              push.push === "build-progress" &&
              push.pendingId === pendingId &&
              push.progress.outcomeLabel !== undefined,
          );
          if (ended === undefined) throw new Error(`build ${pendingId} still going`);
          return ended;
        },
        { timeout: 5000 },
      );

    const builtFrom = async (answer: BuildAnswer): Promise<Built> => {
      if (answer.kind === "error") return answer;
      const { buildId, progress } = await buildEnd(answer.pendingId);
      if (buildId !== undefined) return { kind: "built", id: buildId };
      const failed = progress.steps.find((step) => step.status === "failed");
      return { kind: "error", message: failed?.message ?? progress.chip };
    };

    const buildLatest = async (request: Record<string, unknown> = {}): Promise<Built> => {
      const opened = await handler.handle({ id: nextId++, type: "open-flow", payload: {} });
      const { flowId, version } = (opened as { value: { flowId: string; version: number } }).value;
      const answered = await handler.handle({
        id: nextId++,
        type: "build-version",
        payload: { flowId, version, name: `build-${++names}`, values: {}, ...request },
      });
      return builtFrom((answered as { value: BuildAnswer }).value);
    };

    const builtId = async (request: Record<string, unknown> = {}) => {
      const built = await buildLatest(request);
      if (built.kind !== "built") throw new Error(`did not build: ${JSON.stringify(built)}`);
      return built.id;
    };

    const runBuild = async (buildId: string, extra: Record<string, unknown> = {}) => {
      const response = await handler.handle({
        id: nextId,
        type: "run-build",
        payload: { buildId, ...extra },
      });
      expect(response).toMatchObject({ id: nextId++, ok: true });
      return (response as { value: unknown }).value as Started;
    };

    const startedOn = async (buildId: string) => {
      const result = await runBuild(buildId);
      if (result.kind !== "started") throw new Error(`run did not start: ${result.message}`);
      return result.runId;
    };

    const startRun = async (): Promise<Started> => {
      const built = await buildLatest();
      return built.kind === "error" ? built : runBuild(built.id);
    };

    const startedRunId = async () => {
      const result = await startRun();
      if (result.kind !== "started") throw new Error(`run did not start: ${result.message}`);
      return result.runId;
    };

    const buildDirOf = (buildId: string) => {
      const built = runs.findBuild(buildId);
      if (built === undefined) throw new Error(`no build ${buildId}`);
      return built.dir;
    };

    const worktreeOf = (buildId: string, from = repo.path) =>
      sessionWorktree(buildDirOf(buildId), "main", from);

    const snapshotsOf = (runId: string) =>
      pushes.flatMap((push) =>
        push.push === "run-state" && push.value.runId === runId ? [push.value] : [],
      );

    const sessionPushes = (runId?: string) =>
      pushes.filter(
        (push) => push.push === "session" && (runId === undefined || push.runId === runId),
      );

    const isBuildSession = (push: EnginePush) =>
      push.push === "session" &&
      runs
        .buildEvents(push.runId)
        .some((event) => event.type === "session" && event.name === push.value);

    const expectOnlyBuildSessionsBesides = (runId: string) => {
      expect(
        pushes.filter(
          (push) => push.push === "session" && push.runId !== runId && !isBuildSession(push),
        ),
      ).toEqual([]);
    };

    const untilFinished = async (runId: string) => {
      await vi.waitFor(
        () => {
          expect(snapshotsOf(runId).some((snapshot) => snapshot.status !== "running")).toBe(true);
        },
        { timeout: 5000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const expectErrorAndNoRun = async (message: string | RegExp) => {
      const result = await startRun();
      expect(result).toMatchObject({
        kind: "error",
        message: typeof message === "string" ? message : expect.stringMatching(message),
      });
      expect(runs.runs).toEqual([]);
    };

    const listedStatus = async (runId: string) => {
      const listed = await handler.handle({ id: nextId++, type: "list-runs" });
      return (listed as { value: { id: string; status: string }[] }).value.find(
        (run) => run.id === runId,
      )?.status;
    };

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "fd-home-"));
      repo = await createTmpRepo();
      runs = new FakeStore();
      flows = new FakeFlowStore();
      pushes = [];
      nextId = 1;
      names = 0;
      handler = handlerWith();
    });

    afterEach(async () => {
      await handler.stop();
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    });

    it("runs a build again and again from its one workspace", async () => {
      flows.save(twoAgents());
      const buildId = await builtId();

      const first = await startedOn(buildId);
      await untilFinished(first);
      const second = await startedOn(buildId);
      await untilFinished(second);

      expect(runs.builds()).toHaveLength(1);
      expect(runs.runs.map((run) => [run.id, run.buildId, run.status])).toEqual([
        [first, buildId, "done"],
        [second, buildId, "done"],
      ]);
    });

    it.each([
      ["", false],
      [", after its build is deleted from the store", true],
    ])(
      "answers a live run's cost with a Loop body node's unrecorded usage split by round, the total unchanged%s",
      async (_, buildDeleted) => {
        runs = new FakeStore({ now: () => new Date() });
        const usage = new FakeUsageSource();
        const spent: UsageEntry[] = [];
        const turn: FakeTurnHandler = async (nodeId, opened) => {
          if (nodeId !== "body") return "done";
          const round = spent.length + 1;
          spent.push({
            messageId: `m${round}`,
            model: "claude-haiku-5-5",
            inputTokens: 100,
            outputTokens: round * 1000,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            cacheReadTokens: 0,
            at: Date.now(),
          });
          usage.setEntries(opened.claudeSessionId, [...spent]);
          if (round > 1) return "hold";
          await new Promise((resolve) => setTimeout(resolve, 5));
          return "done";
        };
        handler = handlerWith({
          run: {
            ...runEnvironment(new NodeFileSystem(), Date.now, turn),
            waiter: new FakeWaiter([{ decision: "answer", answer: "again" }]),
            usage,
          },
        });
        flows.save(
          atRepo(
            onWorkspaceMainFlow(
              [
                loop("rounds", { settings: { condition: "done", cap: 3, onCap: "fail" } }),
                agent("body", { parent: "rounds" }),
              ],
              [],
            ),
          ),
        );
        const buildId = await builtId();
        const runId = await startedOn(buildId);
        await vi.waitFor(() => {
          expect(snapshotsOf(runId).at(-1)?.nodes["body"]).toBe("sent");
          expect(spent).toHaveLength(2);
        });
        if (buildDeleted) runs.deleteBuild(buildId);

        const answered = await handler.handle({
          id: nextId++,
          type: "run-cost",
          payload: { runId },
        });

        expect(answered).toMatchObject({ ok: true });
        expect(runs.events(runId).filter((event) => event.kind === "usage")).toEqual([]);
        const report = (
          answered as {
            value: {
              nodes: { nodeId: string; tokens: number; cost: number; rounds?: unknown[] }[];
              total: { tokens: number; cost: number };
            };
          }
        ).value;
        const body = report.nodes.find((line) => line.nodeId === "body");
        expect(body?.tokens).toBe(3200);
        expect(body?.rounds).toEqual([
          { round: 1, tokens: 1100, cost: costOf(spent.slice(0, 1)) },
          { round: 2, tokens: 2100, cost: costOf(spent.slice(1)) },
        ]);
        expect(report.total.cost).toBeCloseTo(costOf(spent), 12);
      },
    );

    it("builds from the latest saved version", async () => {
      flows.save(twoAgents());
      const first = await startedRunId();
      await untilFinished(first);
      const v2 = twoAgents();
      flows.save(
        atRepo(
          onWorkspaceMainFlow(
            v2.nodes.filter((node) => node.id === "write"),
            [],
          ),
        ),
      );

      const second = await startedRunId();
      await untilFinished(second);

      expect(runs.builds()).toHaveLength(2);
      expect(runs.findRun(second)?.nodeIds).toEqual([
        "start",
        "write",
        "stop",
        "session-1-start",
        "session-1-stop",
      ]);
      expect(Object.keys(snapshotsOf(second).at(-1)?.nodes ?? {})).toEqual([
        "start",
        "write",
        "stop",
        "session-1-start",
        "session-1-stop",
      ]);
    });

    it("publishes every node waiting first, and every node done when the run ends", async () => {
      flows.save(twoAgents());

      const runId = await startedRunId();

      expect(
        pushes.find(
          (push) =>
            push.push !== "build-progress" &&
            push.push !== "build-activity" &&
            !isBuildSession(push),
        ),
      ).toEqual({
        push: "run-state",
        value: {
          runId,
          status: "running",
          nodes: {
            start: "waiting",
            write: "waiting",
            check: "waiting",
            stop: "waiting",
            "session-1-start": "waiting",
            "session-1-stop": "waiting",
          },
        },
      });
      await untilFinished(runId);
      expect(snapshotsOf(runId).at(-1)).toEqual({
        runId,
        status: "done",
        nodes: {
          start: "done",
          write: "done",
          check: "done",
          stop: "done",
          "session-1-start": "waiting",
          "session-1-stop": "waiting",
        },
      });
      expect(runs.findRun(runId)?.status).toBe("done");
    });

    it("lists the active run as running and first, and an older run left running as interrupted", async () => {
      const seed = (buildId: string, status?: "done") => {
        runs.recordBuild({
          id: buildId,
          hash: buildId,
          name: buildId,
          repo: repo.path,
          base: "main",
          branch: null,
          branchCreated: null,
          values: {},
          dir: "/nowhere",
          files: [],
          nodes: [],
          manifest: manifestText(sleeper(), buildId),
        });
        const { id } = runs.createRun({
          buildDir: "/nowhere",
          inputs: {},
          nodeIds: ["nap"],
          session: { tmuxName: "fd-run-old", cwd: repo.path, claudeSessionId: "old" },
          buildId,
        });
        if (status !== undefined) runs.finishRun(id, status);
        return id;
      };
      const stale = seed("old-1");
      const finished = seed("old-2", "done");
      flows.save(sleeper());
      const active = await startedRunId();

      const listed = await handler.handle({ id: 99, type: "list-runs" });
      const loaded = await handler.handle({ id: 98, type: "load-run", payload: { runId: active } });

      expect((listed as { value: { id: string; status: string }[] }).value).toEqual([
        expect.objectContaining({ id: active, status: "running" }),
        expect.objectContaining({ id: finished, status: "done" }),
        expect.objectContaining({ id: stale, status: "interrupted" }),
      ]);
      expect(loaded).toMatchObject({
        value: { run: { status: "running" }, snapshot: { status: "running" } },
      });
    });

    it.each([
      ["stop", () => handler.stop()],
      ["detach", () => handler.detach()],
    ] as const)(
      "%s resolves only after the run's pending session-states write has landed",
      async (_, end) => {
        const held = heldStatesWrites();
        handler = handlerWith({ fs: held.fs, run: runEnvironment(held.fs) });
        flows.save(sessionsWorkflow([{ name: "android", repo: repo.path, branch: "main" }]));
        try {
          await startedOn(await builtId());
          await vi.waitFor(() => expect(held.pendingStatesWrites()).toBeGreaterThan(0));
          let ended = false;
          const ending = end().then(() => {
            ended = true;
          });

          await macrotask();
          expect(ended).toBe(false);
          held.release();
          await ending;

          expect(held.pendingStatesWrites()).toBe(0);
        } finally {
          held.release();
        }
      },
    );

    it("writes no session states after a detach issued while the run's events are still starting", async () => {
      const held = heldStatesWrites();
      held.release();
      let eventsReady: () => void = () => undefined;
      const eventsGate = new Promise<void>((resolve) => (eventsReady = resolve));
      const environment = runEnvironment(held.fs);
      handler = handlerWith({
        fs: held.fs,
        run: {
          ...environment,
          startEvents: () => eventsGate.then(() => environment.startEvents()),
        },
      });
      flows.save(sessionsWorkflow([{ name: "android", repo: repo.path, branch: "main" }]));
      await startedOn(await builtId());

      const detaching = handler.detach();
      await macrotask();
      eventsReady();
      await detaching;
      const writtenByDetach = held.statesWritesStarted();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(held.statesWritesStarted()).toBe(writtenByDetach);
    });

    describe("one run at a time per build", () => {
      it("refuses a second run of a running build and creates no run for it", async () => {
        flows.save(sleeper());
        const buildId = await builtId();
        await startedOn(buildId);

        expect(await runBuild(buildId)).toMatchObject({ kind: "error" });
        expect(runs.runs).toHaveLength(1);
      });

      it("refuses a run of a build whose earlier run was left interrupted", async () => {
        flows.save(sleeper());
        const buildId = await builtId();
        runs.createRun({
          buildDir: buildDirOf(buildId),
          inputs: {},
          nodeIds: ["nap"],
          session: { tmuxName: "fd-run-old", cwd: worktreeOf(buildId), claudeSessionId: "old" },
          buildId,
        });

        expect(await runBuild(buildId)).toMatchObject({ kind: "error" });
        expect(runs.runs).toHaveLength(1);
      });

      it("starts a run of a second build while the first build runs, each with its own session", async () => {
        flows.save(sleeper());
        const first = await builtId();
        const second = await builtId();

        const a = await startedOn(first);
        const b = await startedOn(second);

        expect(a).not.toBe(b);
        expect(await listedStatus(a)).toBe("running");
        expect(await listedStatus(b)).toBe("running");
        expect(runs.findRun(a)?.session.tmuxName).not.toBe(runs.findRun(b)?.session.tmuxName);
        expect(runs.findRun(a)?.session.cwd).toBe(workspaceFolder(buildDirOf(first)));
        expect(runs.findRun(b)?.session.cwd).toBe(workspaceFolder(buildDirOf(second)));
      });

      it("accepts only one of two run-builds of one build sent together", async () => {
        flows.save(sleeper());
        const buildId = await builtId();

        const responses = await Promise.all([
          handler.handle({ id: 1, type: "run-build", payload: { buildId } }),
          handler.handle({ id: 2, type: "run-build", payload: { buildId } }),
        ]);

        const values = responses.map((response) => (response as { value: { kind: string } }).value);
        expect(values.filter((value) => value.kind === "started")).toHaveLength(1);
        expect(values.filter((value) => value.kind === "error")).toHaveLength(1);
        expect(runs.runs).toHaveLength(1);
      });

      it("accepts both of two run-builds of different builds sent together", async () => {
        flows.save(sleeper());
        const first = await builtId();
        const second = await builtId();

        const responses = await Promise.all([
          handler.handle({ id: 1, type: "run-build", payload: { buildId: first } }),
          handler.handle({ id: 2, type: "run-build", payload: { buildId: second } }),
        ]);

        expect(
          responses.map((response) => (response as { value: { kind: string } }).value.kind),
        ).toEqual(["started", "started"]);
        expect(runs.runs).toHaveLength(2);
      });

      it("stops every active run when the engine stops", async () => {
        flows.save(sleeper());
        const a = await startedOn(await builtId());
        const b = await startedOn(await builtId());

        await handler.stop();

        expect(runs.findRun(a)?.status).toBe("stopped");
        expect(runs.findRun(b)?.status).toBe("stopped");
      });
    });

    describe("in the build's worktree", () => {
      let source: TmpRepo;

      const promptAt = () =>
        inFolder(
          workspaceFlow(
            [trigger("start"), agent("plan"), output("stop")],
            [thenWire("start", "plan"), thenWire("plan", "stop")],
          ),
          {
            repo: source.path,
            base: "main",
          },
        );

      const twoInSource = () =>
        inFolder(onWorkspaceMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]), {
          repo: source.path,
          base: "main",
        });

      const writesMade =
        (outcome: "done" | "fail"): FakeTurnHandler =>
        async (nodeId, opening) => {
          if (nodeId !== "s1") return "done";
          await writeFile(join(opening.cwd, "made.txt"), "one\n");
          return outcome;
        };

      const sourceWorktreeOf = (buildId: string) => worktreeOf(buildId, source.path);

      const flowdeckBranches = async () =>
        (await branches(source.path)).split("\n").filter((name) => name.startsWith("flowdeck/"));

      const withRealWorktree = (seen: OpenSessionOptions[] = []) =>
        handlerWith({
          worktree: new GitWorktree(),
          gitState: gitAt(source.path),
          run: {
            ...runEnvironment(new NodeFileSystem()),
            openSession: async (opening) => {
              seen.push(opening);
              throw new Error("seen");
            },
          },
        });

      beforeEach(async () => {
        source = await createTmpRepo({ commit: true });
      });

      afterEach(async () => {
        await handler.stop();
        await source.cleanup();
      });

      const containerSessionCwds = (runId: string) =>
        runs
          .runSessions(runId)
          .filter((row) => row.parent !== null)
          .map((row) => row.cwd);

      it("records the session container's session in the build's worktree, adding no worktree", async () => {
        handler = withRealWorktree();
        flows.save(promptAt());
        const buildId = await builtId({ name: "fix-login" });
        const worktreesAtBuild = await worktreePaths(source.path);

        const runId = await startedOn(buildId);
        await untilFinished(runId);

        expect(containerSessionCwds(runId)).toEqual([sourceWorktreeOf(buildId)]);
        expect(await worktreePaths(source.path)).toEqual(worktreesAtBuild);
        expect(await flowdeckBranches()).toEqual([`flowdeck/fix-login-${buildId.slice(0, 8)}`]);
      });

      it("gives two runs of one build the same worktree", async () => {
        handler = withRealWorktree();
        flows.save(promptAt());
        const buildId = await builtId();

        await untilFinished(await startedOn(buildId));
        await untilFinished(await startedOn(buildId));

        expect(runs.runs.flatMap((run) => containerSessionCwds(run.id))).toEqual([
          sourceWorktreeOf(buildId),
          sourceWorktreeOf(buildId),
        ]);
        expect(await worktreePaths(source.path)).toHaveLength(2);
        expect(await flowdeckBranches()).toHaveLength(1);
      });

      it("writes nothing from the run back into the saved flow", async () => {
        handler = withRealWorktree();
        const saved = promptAt();
        flows.save(saved);

        await untilFinished(await startedRunId());

        expect(flows.loadLatest()?.flow).toEqual(saved);
      });

      it.each<[string, FakeTurnHandler, string]>([
        ["changed nothing", () => "done", "done"],
        ["wrote a file", writesMade("done"), "done"],
        ["failed", writesMade("fail"), "failed"],
      ])(
        "keeps the build's worktree and branch after a run that %s, writing no kept notice",
        async (_, turn, status) => {
          handler = handlerWith({
            worktree: new GitWorktree(),
            gitState: gitAt(source.path),
            run: runEnvironment(new NodeFileSystem(), Date.now, turn),
          });
          flows.save(twoInSource());
          const buildId = await builtId();

          const runId = await startedOn(buildId);
          await untilFinished(runId);
          await handler.stop();

          expect(runs.findRun(runId)?.status).toBe(status);
          expect(await worktreePaths(source.path)).toContain(
            await realpath(sourceWorktreeOf(buildId)),
          );
          expect(await flowdeckBranches()).toHaveLength(1);
          expect(runs.activity(runId).filter((entry) => entry.kind === "kept")).toEqual([]);
          expect(
            pushes.filter((push) => push.push === "activity" && push.value.entry.kind === "kept"),
          ).toEqual([]);
        },
      );

      it("fails the worktree sub-step with git's message when the worktree cannot be cut, recording no build", async () => {
        handler = handlerWith({
          worktree: new FakeWorktree({ failWith: "git worktree add exploded" }),
          gitState: gitAt(source.path),
        });
        flows.save(twoInSource());

        const built = await buildLatest();

        expect(built).toMatchObject({ kind: "error" });
        const [ended] = runs.listLatestEndedPendingBuildsByName();
        expect(ended?.outcome).toBe("failed");
        const events = runs.buildEvents(ended?.id ?? "");
        expect(events.at(-1)).toMatchObject({
          type: "worktree",
          status: "failed",
          message: expect.stringMatching(/git worktree add exploded/),
        });
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: "step", step: 2, status: "failed" }),
        );
        expect(runs.listBuilds()).toEqual([]);
        expect(runs.runs).toEqual([]);
      });
    });

    it("returns the hook preparation error", async () => {
      handler = handlerWith({
        prepareHooks: () => ({ kind: "error", message: "No executable node on PATH" }),
      });
      flows.save(twoAgents());

      await expectErrorAndNoRun("No executable node on PATH");
    });

    it("returns the validation problems of a flow that does not build, in plain words", async () => {
      flows.save(
        atRepo(onWorkspaceMainFlow([loop("retry", { settings: { cap: 0, onCap: "fail" } })], [])),
      );

      await expectErrorAndNoRun(/^retry: Loop cap 0 is not a whole number of at least 1\./);
      expect(runs.builds()).toEqual([]);
    });

    it("lists every build problem with its node and field, and no rule ids", async () => {
      flows.save(
        atRepo(
          onWorkspaceMainFlow(
            [
              loop("retry", { settings: { cap: 0, onCap: "fail" } }),
              agent("body", { parent: "retry", settings: { instructions: "" } }),
            ],
            [],
          ),
        ),
      );

      const built = await buildLatest();

      expect(built).toEqual({
        kind: "error",
        message: [
          "retry: Loop cap 0 is not a whole number of at least 1.",
          "body: Write what the agent should do.",
        ].join("\n"),
        problems: [
          { node: "retry", field: "cap", text: "Loop cap 0 is not a whole number of at least 1." },
          { node: "body", field: "instructions", text: "Write what the agent should do." },
        ],
      });
    });

    it("records the build with the version it was made from", async () => {
      flows.save(twoAgents());
      flows.save(twoAgents());

      const runId = await startedRunId();
      await untilFinished(runId);

      const [built] = runs.listBuilds();
      expect(built?.source).toEqual({ flowId: "flow-1", version: 2 });
      expect(runs.findRun(runId)?.buildId).toBe(built?.id);
      expect(runs.buildFiles(built?.id ?? "").map((file) => file.path)).toContain("manifest.json");
    });

    it("leaves a run that joins in SQL to its build, its build nodes, and the flow version", async () => {
      const db = openDatabase({ path: join(home, "flowdeck.db") });
      try {
        const sqlFlows = new SqliteFlowStore({ db, newId: () => "flow-sql" });
        sqlFlows.save(twoAgents());
        sqlFlows.save(twoAgents());
        handler = handlerWith({
          openStores: () => ({ runs: new SqliteStore({ db }), flows: sqlFlows }),
        });

        const runId = await startedRunId();
        await untilFinished(runId);

        const rows = db
          .prepare(
            `SELECT flows.id AS flow, flow_versions.version, builds.id, builds.dir,
                    run_nodes.node_id, build_nodes.type
               FROM runs
               JOIN builds ON builds.id = runs.build_id
               JOIN flow_versions ON flow_versions.flow_id = builds.flow_id
                                 AND flow_versions.version = builds.version
               JOIN flows ON flows.id = flow_versions.flow_id
               JOIN run_nodes ON run_nodes.run_id = runs.id
               JOIN build_nodes ON build_nodes.build_id = builds.id
                               AND build_nodes.node_id = run_nodes.node_id
              WHERE runs.id = ? ORDER BY build_nodes.ordinal`,
          )
          .all(runId) as { id: string; dir: string }[];
        expect(rows).toEqual([
          expect.objectContaining({
            flow: "flow-sql",
            version: 2,
            node_id: "start",
            type: "trigger",
          }),
          expect.objectContaining({
            flow: "flow-sql",
            version: 2,
            node_id: "write",
            type: "agent",
          }),
          expect.objectContaining({
            flow: "flow-sql",
            version: 2,
            node_id: "check",
            type: "agent",
          }),
          expect.objectContaining({
            flow: "flow-sql",
            version: 2,
            node_id: "stop",
            type: "output",
          }),
          expect.objectContaining({
            flow: "flow-sql",
            version: 2,
            node_id: "session-1-start",
            type: "trigger",
          }),
          expect.objectContaining({
            flow: "flow-sql",
            version: 2,
            node_id: "session-1-stop",
            type: "output",
          }),
        ]);
        expect(rows[0]?.dir).toBe(join(home, "workspaces", rows[0]?.id ?? ""));
      } finally {
        await handler.stop();
        db.close();
      }
    });

    it("keeps automatic mode with the run, and nothing else it is sent", async () => {
      flows.save(twoAgents());
      const buildId = await builtId();

      const started = await runBuild(buildId, {
        auto: true,
        inputs: { ticket: "FD-1" },
        flags: { deep: true },
      });
      if (started.kind === "error") throw new Error(started.message);
      await untilFinished(started.runId);

      expect(runs.findRun(started.runId)?.inputs).toEqual({ auto: true });
    });

    it("refuses a run-build without a build id", async () => {
      flows.save(twoAgents());
      await builtId();

      expect(
        await handler.handle({ id: 4, type: "run-build", payload: { hash: "anything" } }),
      ).toMatchObject({ id: 4, ok: false });
      expect(runs.runs).toEqual([]);
    });

    describe("builds", () => {
      it("builds a chosen version under a name, lists it, reads its files, and runs it", async () => {
        const worktree = new FakeWorktree();
        handler = handlerWith({ worktree });
        flows.save(twoAgents());
        const v1 = twoAgents();
        flows.save({ ...v1, nodes: v1.nodes.filter((node) => node.id === "write"), wires: [] });

        const answered = await handler.handle({
          id: 1,
          type: "build-version",
          payload: { flowId: "flow-1", version: 1, name: "fix-login", base: "main", values: {} },
        });
        expect(answered).toMatchObject({ id: 1, ok: true, value: { kind: "started" } });
        const built = await builtFrom((answered as { value: BuildAnswer }).value);
        expect(built).toMatchObject({ kind: "built" });
        const id = built.kind === "built" ? built.id : "";
        const dir = buildDirOf(id);
        expect(dir).toBe(join(home, "workspaces", id));
        expect(worktree.calls).toEqual([
          {
            repo: repo.path,
            base: "main",
            branch: `flowdeck/fix-login-${id.slice(0, 8)}`,
            create: true,
            path: sessionWorktree(dir, "main", repo.path),
          },
        ]);

        const listedBuilds = await handler.handle({ id: 2, type: "list-builds" });
        expect(listedBuilds).toEqual({
          id: 2,
          ok: true,
          value: [
            expect.objectContaining({
              id,
              name: "fix-login",
              dir,
              createdAt: expect.any(Number),
              source: { flowId: "flow-1", version: 1 },
            }),
          ],
        });
        expect((listedBuilds as { value: object[] }).value[0]).not.toHaveProperty("old");

        const files = await handler.handle({
          id: 3,
          type: "build-files",
          payload: { buildId: id },
        });
        const listed = (files as { value: { path: string; content: string }[] }).value;
        expect(listed.map((file) => file.path)).toEqual(runs.buildFiles(id).map((f) => f.path));
        expect(listed.find((file) => file.path === "manifest.json")?.content).toBe(
          await new NodeFileSystem().readFile(`${dir}/manifest.json`),
        );

        const started = await handler.handle({
          id: 4,
          type: "run-build",
          payload: { buildId: id },
        });
        const { runId } = (started as { value: { runId: string } }).value;
        await untilFinished(runId);
        expect(runs.findRun(runId)).toMatchObject({
          buildId: id,
          nodeIds: ["start", "write", "check", "stop", "session-1-start", "session-1-stop"],
          status: "done",
        });
      });

      it.each([
        { mode: "existing", branch: { mode: "existing", name: "feat-y" }, created: false },
        {
          mode: "new",
          branch: { mode: "new", name: "flowdeck/login-fix", base: "main" },
          created: true,
        },
      ])("builds on the $mode branch the request names", async ({ branch, created }) => {
        const worktree = new FakeWorktree();
        handler = handlerWith({
          worktree,
          gitState: new FakeGitState(
            { [repo.path]: { kind: "branch", name: "main" } },
            { branches: { [repo.path]: ["main", "feat-y"] } },
          ),
        });
        flows.save(twoAgents());

        const answered = await handler.handle({
          id: 1,
          type: "build-version",
          payload: { flowId: "flow-1", version: 1, name: "fix-login", values: {}, branch },
        });

        const built = await builtFrom((answered as { value: BuildAnswer }).value);
        if (built.kind !== "built") throw new Error(`did not build: ${JSON.stringify(built)}`);
        expect(worktree.calls).toEqual([
          expect.objectContaining({ branch: branch.name, create: created }),
        ]);
        expect(runs.findBuild(built.id)).toMatchObject({
          branch: branch.name,
          branchCreated: created,
        });
      });

      it("builds one version twice under two names as two builds", async () => {
        flows.save(twoAgents());

        const first = await builtId({ name: "first" });
        const second = await builtId({ name: "second" });

        expect(first).not.toBe(second);
        const listed = await handler.handle({ id: 9, type: "list-builds" });
        expect(
          (listed as { value: { id: string; name: string }[] }).value.map((b) => [b.id, b.name]),
        ).toEqual(
          expect.arrayContaining([
            [first, "first"],
            [second, "second"],
          ]),
        );
        expect(runs.findBuild(first)?.dir).not.toBe(runs.findBuild(second)?.dir);
      });

      it("leaves a loose node out of the workspace manifest and out of the run", async () => {
        const main = twoAgents();
        const workspace = main.containers.find((container) => container.kind === "workspace");
        if (workspace === undefined) throw new Error("twoAgents has no workspace container");
        flows.save({
          ...main,
          nodes: [...main.nodes, agent("loose")] as Flow["nodes"],
          containers: main.containers.map((container) =>
            container === workspace
              ? { ...workspace, nodes: [...workspace.nodes, "loose"] }
              : container,
          ),
        });
        const mainIds = workspace.nodes;

        const buildId = await builtId();
        const manifest = JSON.parse(
          await new NodeFileSystem().readFile(`${buildDirOf(buildId)}/manifest.json`),
        ) as { containers: { kind: string; nodes: { id: string }[] }[] };
        const runId = await startedOn(buildId);
        await untilFinished(runId);

        expect(
          manifest.containers
            .find((container) => container.kind === "workspace")
            ?.nodes.map((node) => node.id),
        ).toEqual(mainIds);
        expect(runs.findRun(runId)?.nodeIds).toEqual([
          ...mainIds,
          "session-1-start",
          "session-1-stop",
        ]);
      });

      it("answers an unsaved version, an unknown build and a bad payload with errors", async () => {
        flows.save(twoAgents());

        expect(
          await handler.handle({
            id: 1,
            type: "build-version",
            payload: { flowId: "flow-1", version: 5, name: "fix-login", values: {} },
          }),
        ).toEqual({
          id: 1,
          ok: true,
          value: {
            kind: "error",
            message: "flow-1 has no saved version 5",
            problems: [{ text: "flow-1 has no saved version 5" }],
          },
        });
        expect(
          await handler.handle({ id: 2, type: "run-build", payload: { buildId: "nope" } }),
        ).toEqual({ id: 2, ok: true, value: { kind: "error", message: "No build nope" } });
        expect(
          await handler.handle({ id: 3, type: "build-files", payload: { buildId: "nope" } }),
        ).toEqual({ id: 3, ok: false, error: "No build nope" });
        expect(await handler.handle({ id: 4, type: "build-version", payload: {} })).toMatchObject({
          id: 4,
          ok: false,
        });
        expect(runs.runs).toEqual([]);
      });
    });

    describe("build-version in stages", () => {
      class HeldWorktree extends FakeWorktree {
        private gate: Promise<void> | undefined;
        private open: () => void = () => undefined;

        hold() {
          this.gate = new Promise((resolve) => {
            this.open = resolve;
          });
        }

        release() {
          this.open();
          this.gate = undefined;
        }

        override async add(options: WorktreeAddOptions): Promise<void> {
          await this.gate;
          return super.add(options);
        }
      }

      type ProgressPush = Extract<EnginePush, { push: "build-progress" }>;

      let worktree: HeldWorktree;

      const progressPushes = (pendingId: string) =>
        pushes.filter(
          (push): push is ProgressPush =>
            push.push === "build-progress" && push.pendingId === pendingId,
        );

      const answeredWithin = async (pending: Promise<unknown>, ms = 1000) =>
        Promise.race([
          pending,
          new Promise((resolve) => setTimeout(() => resolve("still building"), ms)),
        ]);

      const buildVersionOf = (flowId: string, name: string) =>
        answeredWithin(
          handler.handle({
            id: nextId++,
            type: "build-version",
            payload: { flowId, version: 1, name, values: {} },
          }),
        );

      const startedPendingId = async (flowId: string, name: string) => {
        const answered = await buildVersionOf(flowId, name);
        expect(answered).toMatchObject({
          ok: true,
          value: { kind: "started", pendingId: expect.any(String) },
        });
        return (answered as { value: { pendingId: string } }).value.pendingId;
      };

      const untilBuilt = (pendingId: string) =>
        vi.waitFor(
          () => {
            expect(progressPushes(pendingId).at(-1)?.progress.chip).toBe("Built · v1");
          },
          { timeout: 3000 },
        );

      beforeEach(() => {
        worktree = new HeldWorktree();
        handler = handlerWith({ worktree });
      });

      afterEach(async () => {
        worktree.release();
        await vi.waitFor(() => {
          expect(runs.listPendingBuilds()).toEqual([]);
        });
      });

      it("answers started with the pending id before the build ends, recording no build yet", async () => {
        flows.save(twoAgents());
        worktree.hold();

        const answered = await buildVersionOf("flow-1", "fix-login");

        expect(answered).toEqual({
          id: 1,
          ok: true,
          value: { kind: "started", pendingId: expect.any(String) },
        });
        const { pendingId } = (answered as { value: { pendingId: string } }).value;
        expect(runs.listPendingBuilds()).toEqual([
          expect.objectContaining({
            id: pendingId,
            flowId: "flow-1",
            version: 1,
            name: "fix-login",
          }),
        ]);
        expect(runs.listBuilds()).toEqual([]);
      });

      it("pushes the build's progress once for each event, the last Built · v1 with the build id", async () => {
        flows.save(twoAgents());

        const pendingId = await startedPendingId("flow-1", "fix-login");
        await untilBuilt(pendingId);

        const sent = progressPushes(pendingId);
        expect(runs.buildEvents(pendingId)).toHaveLength(20);
        expect(sent.map((push) => push.progress.chip)).toEqual([
          ...Array<string>(2).fill("Building · step 1 of 5"),
          ...Array<string>(4).fill("Building · step 2 of 5"),
          ...Array<string>(8).fill("Building · step 3 of 5"),
          ...Array<string>(4).fill("Building · step 4 of 5"),
          ...Array<string>(2).fill("Building · step 5 of 5"),
          "Built · v1",
        ]);
        const [built] = runs.listBuilds();
        expect(built).toBeDefined();
        expect(sent.at(-1)?.buildId).toBe(built?.id);
      });

      it("pushes each entry with the build's name, start, events, blueprint and blueprint id", async () => {
        flows.save(twoAgents(), { name: "Nightly" });

        const pendingId = await startedPendingId("flow-1", "fix-login");
        await untilBuilt(pendingId);

        const sent = progressPushes(pendingId);
        const ended = runs.pendingBuild(pendingId);
        expect(sent.every((push) => push.flowId === "flow-1")).toBe(true);
        expect(sent.at(-1)).toMatchObject({
          pendingId,
          name: "fix-login",
          startedAt: ended?.startedAt,
          endedAt: ended?.endedAt,
          outcome: "built",
          blueprintName: "Nightly",
          blueprintVersion: 1,
          events: runs.buildEvents(pendingId),
        });
      });

      it("starts a second build of the blueprint under another name while it builds, and refuses the same name", async () => {
        flows.save(twoAgents());
        worktree.hold();
        const first = await startedPendingId("flow-1", "fix-login");

        const second = await buildVersionOf("flow-1", "fix-other");
        const again = await buildVersionOf("flow-1", "fix-login");

        expect(second).toMatchObject({
          ok: true,
          value: { kind: "started", pendingId: expect.any(String) },
        });
        expect(again).toMatchObject({
          ok: true,
          value: { kind: "error", message: "A build named fix-login is already building." },
        });
        const { pendingId: secondId } = (second as { value: { pendingId: string } }).value;
        expect(runs.listPendingBuilds().map((pending) => pending.id)).toEqual([first, secondId]);
      });

      it("lists every open build and each name's latest ended one, from the store alone", async () => {
        flows.save(twoAgents(), { name: "Nightly" });
        handler = handlerWith({ worktree: new FakeWorktree({ failWith: "git said no" }) });
        const failed = await startedPendingId("flow-1", "fix-a");
        await vi.waitFor(() => {
          expect(progressPushes(failed).at(-1)?.progress.chip).toBe("Failed");
        });
        handler = handlerWith({ worktree });
        const built = await startedPendingId("flow-1", "fix-b");
        await untilBuilt(built);
        worktree.hold();
        const open = await startedPendingId("flow-1", "fix-c");
        await vi.waitFor(() => {
          expect(progressPushes(open).at(-1)?.progress.chip).toBe("Building · step 2 of 5");
        });
        const withoutBlueprint = handlerWith({
          worktree,
          openStores: () => ({ runs, flows: new FakeFlowStore() }),
        });

        const listed = await withoutBlueprint.handle({ id: nextId++, type: "build-progress-list" });

        expect(listed).toMatchObject({ ok: true });
        const value = (listed as { value: Record<string, unknown>[] }).value;
        expect(value.map((entry) => entry.pendingId).sort()).toEqual([failed, open].sort());
        expect(value.every((entry) => entry.flowId === "flow-1")).toBe(true);
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              pendingId: open,
              name: "fix-c",
              blueprintName: "Nightly",
              blueprintVersion: 1,
              progress: expect.objectContaining({ chip: "Building · step 2 of 5" }),
            }),
            expect.objectContaining({
              pendingId: failed,
              name: "fix-a",
              outcome: "failed",
              blueprintName: "Nightly",
              blueprintVersion: 1,
              events: runs.buildEvents(failed),
            }),
          ]),
        );
      });
    });

    describe("the build session", () => {
      type OpenSpec = BuildAgentsOpenSpec & { claudeSessionId?: string };
      type ProgressPush = Extract<EnginePush, { push: "build-progress" }>;

      class WatchedBuildAgents implements BuildAgents {
        readonly fake: FakeBuildAgents;
        turnsStarted = 0;
        private held = false;

        constructor(
          private readonly onOpen: (spec: OpenSpec) => void,
          script?: FakeBuildScript,
        ) {
          this.fake = new FakeBuildAgents({
            fs: new NodeFileSystem(),
            ...(script === undefined ? {} : { script }),
          });
        }

        holdTurns() {
          this.held = true;
        }

        readonly open: BuildAgents["open"] = async (spec) => {
          this.onOpen(spec);
          return this.fake.open(spec);
        };

        readonly turn: BuildAgents["turn"] = async (sessionName, text, onCall, onStep) => {
          this.turnsStarted += 1;
          if (this.held) return new Promise<BuildTurnResult>(() => undefined);
          return this.fake.turn(sessionName, text, onCall, onStep);
        };

        readonly alive: BuildAgents["alive"] = (sessionName) => this.fake.alive(sessionName);

        readonly close: BuildAgents["close"] = (sessionName) => this.fake.close(sessionName);
      }

      const usageEntries: UsageEntry[] = [
        {
          messageId: "m1",
          model: "claude-sonnet-5",
          inputTokens: 1200,
          outputTokens: 300,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
        },
        {
          messageId: "m2",
          model: "claude-sonnet-5",
          inputTokens: 800,
          outputTokens: 200,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
        },
      ];

      let agents: WatchedBuildAgents;
      let usage: FakeUsageSource;

      const startedPendingId = async (
        name = "fix-login",
        extra: { buildModel?: string; version?: number } = {},
      ) => {
        const answered = await handler.handle({
          id: nextId++,
          type: "build-version",
          payload: { flowId: "flow-1", version: 1, name, values: {}, ...extra },
        });
        expect(answered).toMatchObject({ ok: true, value: { kind: "started" } });
        return (answered as { value: { pendingId: string } }).value.pendingId;
      };

      const endPush = (pendingId: string) =>
        vi.waitFor(
          () => {
            const ended = pushes.findLast(
              (push): push is ProgressPush =>
                push.push === "build-progress" &&
                push.pendingId === pendingId &&
                push.progress.outcomeLabel !== undefined,
            );
            if (ended === undefined) throw new Error(`build ${pendingId} still going`);
            return ended;
          },
          { timeout: 3000 },
        );

      const piecesTurned = () =>
        agents.fake.turns.flatMap(({ text }) =>
          text.split("\n").flatMap((line) => {
            const marker = markerOf(line);
            return "piece" in marker ? [marker.piece] : [];
          }),
        );

      const sessionEventName = (pendingId: string) =>
        runs
          .buildEvents(pendingId)
          .flatMap((event) => (event.type === "session" ? [event.name] : []))
          .at(0);

      beforeEach(() => {
        usage = new FakeUsageSource();
        agents = new WatchedBuildAgents(({ claudeSessionId }) => {
          if (claudeSessionId !== undefined) usage.setEntries(claudeSessionId, usageEntries);
        });
        handler = handlerWith({
          buildAgents: agents,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        flows.save(twoAgents());
      });

      afterEach(async () => {
        await vi.waitFor(() => {
          expect(runs.listPendingBuilds()).toEqual([]);
        });
      });

      it("opens the build session with the build model the request names, and records it on the session event", async () => {
        const pendingId = await startedPendingId("fix-login", { buildModel: "haiku" });
        await endPush(pendingId);

        expect(agents.fake.opened.map((spec) => spec.model)).toEqual(["haiku"]);
        expect(
          runs.buildEvents(pendingId).flatMap((event) => (event.type === "session" ? [event] : [])),
        ).toEqual([expect.objectContaining({ model: "haiku" })]);
      });

      it("opens the build session with the blueprint's own build model when the request names none", async () => {
        const blueprint = twoAgents();
        const { version } = flows.save(
          { ...blueprint, settings: { ...blueprint.settings, buildModel: "opus" } },
          "flow-1",
        );

        const pendingId = await startedPendingId("fix-login", { version });
        await endPush(pendingId);

        expect(agents.fake.opened.map((spec) => spec.model)).toEqual(["opus"]);
      });

      it("announces the build session under the pending id", async () => {
        const pendingId = await startedPendingId();
        await endPush(pendingId);

        const name = sessionEventName(pendingId);
        expect(name).toMatch(/^fd-build-/);
        expect(sessionPushes(pendingId)).toContainEqual({
          push: "session",
          runId: pendingId,
          value: name,
        });
      });

      it("stops a build mid-turn: closes its session, removes its workspace, ends it stopped and keeps its events", async () => {
        agents.holdTurns();
        const pendingId = await startedPendingId();
        await vi.waitFor(() => {
          expect(agents.turnsStarted).toBe(1);
        });
        const [opened] = agents.fake.opened;
        if (opened === undefined) throw new Error("the build session never opened");
        expect(await new NodeFileSystem().exists(opened.workspaceDir)).toBe(true);
        expect(await new NodeFileSystem().exists(opened.settingsPath)).toBe(true);
        const eventsBefore = runs.buildEvents(pendingId);

        const stopped = await Promise.race([
          handler.handle({ id: nextId++, type: "build-stop", payload: { pendingId } }),
          new Promise((resolve) => setTimeout(() => resolve("still stopping"), 1000)),
        ]);

        expect(stopped).toMatchObject({ ok: true });
        const ended = await endPush(pendingId);
        expect(ended.progress).toMatchObject({ chip: "Failed", outcomeLabel: "Stopped" });
        expect(runs.listPendingBuilds()).toEqual([]);
        expect(agents.fake.closed).toEqual([opened.sessionName]);
        expect(await new NodeFileSystem().exists(opened.workspaceDir)).toBe(false);
        expect(await new NodeFileSystem().exists(dirname(opened.settingsPath))).toBe(false);
        expect(runs.buildEvents(pendingId).slice(0, eventsBefore.length)).toEqual(eventsBefore);
        expect(runs.listBuilds()).toEqual([]);
      });

      describe("going builds at quit", () => {
        const quitAnswer = async (type: "going-runs" | "stop-going-runs") => {
          const answered = await handler.handle({ id: nextId++, type });
          expect(answered).toMatchObject({ ok: true });
          return (answered as { value: unknown }).value;
        };

        const heldBuild = async () => {
          agents.holdTurns();
          const pendingId = await startedPendingId();
          await vi.waitFor(() => {
            expect(agents.turnsStarted).toBe(1);
          });
          const [opened] = agents.fake.opened;
          if (opened === undefined) throw new Error("the build session never opened");
          return { pendingId, sessionName: opened.sessionName };
        };

        it("lists a build it is driving and leaves it going", async () => {
          const { pendingId } = await heldBuild();

          expect(await quitAnswer("going-runs")).toEqual({ runIds: [], pendingIds: [pendingId] });
          expect(agents.fake.closed).toEqual([]);
          expect(runs.pendingBuild(pendingId)?.endedAt).toBeUndefined();

          await handler.handle({ id: nextId++, type: "build-stop", payload: { pendingId } });
        });

        it("stops a build it is driving the way Stop does before it answers", async () => {
          const { pendingId, sessionName } = await heldBuild();

          expect(await quitAnswer("stop-going-runs")).toEqual({
            runIds: [],
            pendingIds: [pendingId],
          });
          expect(agents.fake.closed).toEqual([sessionName]);
          expect(runs.pendingBuild(pendingId)?.outcome).toBe("stopped");
          expect((await endPush(pendingId)).progress).toMatchObject({ outcomeLabel: "Stopped" });
        });

        it("lists nothing when nothing is going", async () => {
          expect(await quitAnswer("going-runs")).toEqual({ runIds: [], pendingIds: [] });
        });
      });

      it("stops a build before its session opens: leaves neither its settings folder nor its workspace", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const asked: string[] = [];
        const writes = new NodeFileSystem();
        const fs: FileSystem = Object.assign(Object.create(writes) as NodeFileSystem, {
          writeFile: async (path: string, content: string) => {
            if (path.startsWith(join(home, "workspaces"))) {
              asked.push(path);
              await gate;
            }
            await writes.writeFile(path, content);
          },
        });
        handler = handlerWith({
          buildAgents: agents,
          fs,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId();
        await vi.waitFor(() => {
          expect(asked).toHaveLength(1);
        });

        const stopping = handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        release();
        expect(await stopping).toMatchObject({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(runs.buildEvents(pendingId).some((entry) => entry.type === "session")).toBe(false);
        expect(await readdir(join(home, "workspaces")).catch(() => [])).toEqual([]);
        expect(await readdir(join(home, "build-sessions")).catch(() => [])).toEqual([]);
        expect(agents.fake.opened).toEqual([]);
      });

      it("records the build session's transcript cost after each turn, read under its Claude session id", async () => {
        const pendingId = await startedPendingId();
        await endPush(pendingId);

        const [opened] = agents.fake.opened as OpenSpec[];
        const claudeSessionId = opened?.claudeSessionId;
        expect(claudeSessionId).toEqual(expect.any(String));
        expect(claudeSessionId).not.toBe(opened?.sessionName);
        expect(usage.calls).toContain(claudeSessionId);
        const costs = runs.buildEvents(pendingId).filter((event) => event.type === "cost");
        expect(costs).toHaveLength(agents.fake.turns.length);
        expect(costs.at(-1)).toMatchObject({
          inputTokens: 2000,
          outputTokens: 500,
          usd: costOf(usageEntries),
        });
      });

      it("folds each agent call of the build session into the build's Activity, owned by its piece", async () => {
        const pendingId = await startedPendingId();
        await endPush(pendingId);

        const pieces = piecesTurned();
        expect(pieces.length).toBeGreaterThan(0);
        const activity = runs.buildActivity(pendingId);
        const ownerById = new Map(activity.map((entry) => [entry.id, entry.nodeId]));
        expect([...ownerById.values()].sort()).toEqual([...pieces].sort());
      });

      it("folds a build agent's own steps and report into its piece's Activity, and none into another piece", async () => {
        const writePiece = "workspace/plugin/agents/write.md";
        const checkPiece = "workspace/plugin/agents/check.md";
        const read = {
          agent_id: "ag-write",
          agent_type: "general-purpose",
          tool_name: "Read",
          tool_use_id: "read-write",
          tool_input: { file_path: "/work/plugin/agents/write.md" },
          flowdeck_hook_at: 20,
        };
        agents = new WatchedBuildAgents(() => undefined, {
          steps: {
            [writePiece]: [
              { kind: "PreToolUse", payload: read },
              {
                kind: "PostToolUse",
                payload: { ...read, tool_response: "body", duration_ms: 3 },
              },
            ],
          },
          reports: { [writePiece]: "Wrote the write piece." },
        });
        handler = handlerWith({
          buildAgents: agents,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId();
        await endPush(pendingId);

        expect(piecesTurned()).toEqual(expect.arrayContaining([writePiece, checkPiece]));
        const latest = [
          ...new Map(runs.buildActivity(pendingId).map((entry) => [entry.id, entry])).values(),
        ];
        const stepsOf = (piece: string) =>
          latest.flatMap((entry) =>
            entry.kind === "tool" && entry.nodeId === piece
              ? [[entry.toolUseId, entry.result, entry.durationMs]]
              : [],
          );
        expect(stepsOf(writePiece)).toEqual([["read-write", "ok", 3]]);
        expect(stepsOf(checkPiece)).toEqual([]);
        const finishes = latest.flatMap((entry) =>
          entry.kind === "subagent" && entry.state === "finished"
            ? [[entry.nodeId, entry.report]]
            : [],
        );
        expect(finishes).toEqual(
          expect.arrayContaining([
            [writePiece, "Wrote the write piece."],
            [checkPiece, undefined],
          ]),
        );
      });

      it("pushes each build activity entry under its pending id, and answers build-activity with them", async () => {
        const pendingId = await startedPendingId();
        await endPush(pendingId);

        const stored = runs.buildActivity(pendingId);
        expect(stored.length).toBeGreaterThan(0);
        const pushed = pushes.flatMap((push) =>
          push.push === "build-activity" && push.pendingId === pendingId ? [push.entry] : [],
        );
        expect(pushed).toEqual(stored);
        const answered = await handler.handle({
          id: nextId++,
          type: "build-activity",
          payload: { pendingId },
        });
        expect(answered).toMatchObject({ ok: true, value: stored });
      });

      it("ends a build that asks with its questions on the last progress push", async () => {
        const questions = [{ nodeId: "s1", text: "Who writes notes.md?", otherNodeId: "s2" }];
        agents = new WatchedBuildAgents(() => undefined, { questions });
        handler = handlerWith({
          buildAgents: agents,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId();

        const ended = await endPush(pendingId);

        expect(ended.progress.chip).toBe("Needs you");
        expect(ended.progress.questions).toEqual(questions);
      });

      it("lists a build that ended asking, with its questions, after the engine restarts", async () => {
        const questions = [{ nodeId: "s1", text: "Who writes notes.md?", otherNodeId: "s2" }];
        agents = new WatchedBuildAgents(() => undefined, { questions });
        handler = handlerWith({
          buildAgents: agents,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId();
        await endPush(pendingId);

        const restarted = handlerWith({
          buildAgents: agents,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const listed = await restarted.handle({ id: nextId++, type: "build-progress-list" });

        expect(listed).toMatchObject({
          ok: true,
          value: [
            {
              pendingId,
              outcome: "needs-you",
              progress: expect.objectContaining({ chip: "Needs you", questions }),
            },
          ],
        });
      });

      it("stops a build whose worktree is already cut: removes the worktree and its branch too", async () => {
        const added: WorktreeAddOptions[] = [];
        const source = await createTmpRepo({ commit: true });
        onTestFinished(() => source.cleanup());
        const git = new GitWorktree();
        let releaseCut: () => void = () => undefined;
        const cutGate = new Promise<void>((resolve) => {
          releaseCut = resolve;
        });
        handler = handlerWith({
          buildAgents: agents,
          gitState: gitAt(source.path),
          run: { ...runEnvironment(new NodeFileSystem()), usage },
          worktree: {
            add: async (options) => {
              await git.add(options);
              added.push(options);
              await cutGate;
            },
            remove: (options) => git.remove(options),
            isDirty: (path) => git.isDirty(path),
            hasUnpushed: (repo, branch, base) => git.hasUnpushed(repo, branch, base),
            deleteBranch: (repo, branch) => git.deleteBranch(repo, branch),
            branchTip: (repo, branch) => git.branchTip(repo, branch),
            deleteRemoteBranch: (repo, branch, tip) => git.deleteRemoteBranch(repo, branch, tip),
            checkoutAt: (path) => git.checkoutAt(path),
          },
        });
        const saved = flows.save(
          inFolder(twoAgents(), { repo: source.path, base: "main" }),
          "flow-1",
        );
        const answered = await handler.handle({
          id: nextId++,
          type: "build-version",
          payload: { ...saved, name: "cut-then-stop", values: {} },
        });
        expect(answered).toMatchObject({ ok: true, value: { kind: "started" } });
        const { pendingId } = (answered as { value: { pendingId: string } }).value;
        await vi.waitFor(() => {
          expect(added).toHaveLength(1);
        });
        const [cut] = added;
        if (cut === undefined) throw new Error("no worktree was cut");
        const cutPath = await realpath(cut.path);
        expect(await worktreePaths(cut.repo)).toContain(cutPath);

        const stopping = handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        releaseCut();

        expect(await stopping).toMatchObject({ ok: true });
        const ended = await endPush(pendingId);
        expect(ended.progress).toMatchObject({ outcomeLabel: "Stopped" });
        expect(await worktreePaths(cut.repo)).not.toContain(cutPath);
        expect((await branches(cut.repo)).split("\n")).not.toContain(cut.branch);
      });

      it("records no build when its worktree is cut only after a stop, and removes that worktree and branch", async () => {
        const source = await createTmpRepo({ commit: true });
        onTestFinished(() => source.cleanup());
        const git = new GitWorktree();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const asked: WorktreeAddOptions[] = [];
        const settled: WorktreeAddOptions[] = [];
        handler = handlerWith({
          buildAgents: agents,
          gitState: gitAt(source.path),
          run: { ...runEnvironment(new NodeFileSystem()), usage },
          worktree: {
            add: async (options) => {
              asked.push(options);
              await gate;
              await git.add(options);
              settled.push(options);
            },
            remove: (options) => git.remove(options),
            isDirty: (path) => git.isDirty(path),
            hasUnpushed: (repo, branch, base) => git.hasUnpushed(repo, branch, base),
            deleteBranch: (repo, branch) => git.deleteBranch(repo, branch),
            branchTip: (repo, branch) => git.branchTip(repo, branch),
            deleteRemoteBranch: (repo, branch, tip) => git.deleteRemoteBranch(repo, branch, tip),
            checkoutAt: (path) => git.checkoutAt(path),
          },
        });
        const saved = flows.save(
          inFolder(twoAgents(), { repo: source.path, base: "main" }),
          "flow-1",
        );
        const answered = await handler.handle({
          id: nextId++,
          type: "build-version",
          payload: { ...saved, name: "stop-then-cut", values: {} },
        });
        expect(answered).toMatchObject({ ok: true, value: { kind: "started" } });
        const { pendingId } = (answered as { value: { pendingId: string } }).value;
        await vi.waitFor(() => {
          expect(asked).toHaveLength(1);
        });
        const [cut] = asked;
        if (cut === undefined) throw new Error("no worktree was asked for");

        const stopping = handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        release();
        expect(await stopping).toMatchObject({ ok: true });
        await vi.waitFor(() => {
          expect(settled).toHaveLength(1);
        });

        await vi.waitFor(async () => {
          expect((await branches(cut.repo)).split("\n")).not.toContain(cut.branch);
        });
        expect(runs.listBuilds()).toEqual([]);
        expect(
          pushes.findLast(
            (push): push is ProgressPush =>
              push.push === "build-progress" && push.pendingId === pendingId,
          )?.progress.outcomeLabel,
        ).toBe("Stopped");
        expect(await worktreePaths(cut.repo)).toHaveLength(1);
        expect(await new NodeFileSystem().exists(cut.path)).toBe(false);
      });

      it("opens no build session when Stop lands during the worktree cut, and removes the workspace and worktree", async () => {
        const source = await createTmpRepo({ commit: true });
        onTestFinished(() => source.cleanup());
        const git = new GitWorktree();
        let releaseAdd: () => void = () => undefined;
        const addGate = new Promise<void>((resolve) => {
          releaseAdd = resolve;
        });
        const asked: WorktreeAddOptions[] = [];
        handler = handlerWith({
          buildAgents: agents,
          gitState: gitAt(source.path),
          run: { ...runEnvironment(new NodeFileSystem()), usage },
          worktree: {
            add: async (options) => {
              asked.push(options);
              await addGate;
              await git.add(options);
            },
            remove: (options) => git.remove(options),
            isDirty: (path) => git.isDirty(path),
            hasUnpushed: (repo, branch, base) => git.hasUnpushed(repo, branch, base),
            deleteBranch: (repo, branch) => git.deleteBranch(repo, branch),
            branchTip: (repo, branch) => git.branchTip(repo, branch),
            deleteRemoteBranch: (repo, branch, tip) => git.deleteRemoteBranch(repo, branch, tip),
            checkoutAt: (path) => git.checkoutAt(path),
          },
        });
        const saved = flows.save(
          inFolder(twoAgents(), { repo: source.path, base: "main" }),
          "flow-1",
        );
        const answered = await handler.handle({
          id: nextId++,
          type: "build-version",
          payload: { ...saved, name: "cut-while-stopping", values: {} },
        });
        expect(answered).toMatchObject({ ok: true, value: { kind: "started" } });
        const { pendingId } = (answered as { value: { pendingId: string } }).value;
        await vi.waitFor(() => {
          expect(asked).toHaveLength(1);
        });
        const [cut] = asked;
        if (cut === undefined) throw new Error("no worktree was asked for");

        const stopping = handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        releaseAdd();

        expect(await stopping).toMatchObject({ ok: true });
        const ended = await endPush(pendingId);
        expect(ended.progress).toMatchObject({ outcomeLabel: "Stopped" });
        expect(
          runs.listLatestEndedPendingBuildsByName().find((pending) => pending.id === pendingId)
            ?.outcome,
        ).toBe("stopped");
        expect(agents.fake.opened).toEqual([]);
        expect(sessionEventName(pendingId)).toBeUndefined();
        expect(runs.listBuilds()).toEqual([]);
        expect(await worktreePaths(cut.repo)).toHaveLength(1);
        expect((await branches(cut.repo)).split("\n")).not.toContain(cut.branch);
        expect(await new NodeFileSystem().exists(dirname(cut.path))).toBe(false);
      });

      it("keeps a build recorded before a stop: its workspace stays and it ends built", async () => {
        let releaseClose: () => void = () => undefined;
        const closeGate = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        const closing: string[] = [];
        handler = handlerWith({
          buildAgents: {
            open: agents.open,
            turn: agents.turn,
            alive: agents.alive,
            close: async (sessionName) => {
              closing.push(sessionName);
              if (closing.length === 1) await closeGate;
              return agents.close(sessionName);
            },
          },
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId("recorded-then-stopped");
        await vi.waitFor(() => {
          expect(closing).toHaveLength(1);
        });
        const [recorded] = runs.listBuilds();
        if (recorded === undefined) throw new Error("the build was not recorded before the stop");

        const stopped = await handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        releaseClose();

        expect(stopped).toMatchObject({ ok: true });
        await vi.waitFor(() => {
          expect(runs.listPendingBuilds()).toEqual([]);
        });
        expect(runs.listBuilds().map((build) => build.id)).toEqual([recorded.id]);
        expect(await new NodeFileSystem().exists(workspaceDir(home, recorded.id))).toBe(true);
        expect(runs.pendingBuild(pendingId)?.outcome).toBe("built");
        expect(runs.listLatestEndedPendingBuildsByName()).toEqual([]);
        const ended = await endPush(pendingId);
        expect(ended.progress.outcomeLabel).not.toBe("Stopped");
      });

      const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

      it("stops a build while its session opens: sends no turn after the stop and closes the session", async () => {
        let releaseOpen: () => void = () => undefined;
        const openGate = new Promise<void>((resolve) => {
          releaseOpen = resolve;
        });
        const opening: string[] = [];
        handler = handlerWith({
          buildAgents: {
            open: async (spec) => {
              opening.push(spec.sessionName);
              await openGate;
              return agents.open(spec);
            },
            turn: agents.turn,
            alive: agents.alive,
            close: agents.close,
          },
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId("stop-while-opening");
        await vi.waitFor(() => {
          expect(opening).toHaveLength(1);
        });

        const stopping = handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        releaseOpen();

        expect(await stopping).toMatchObject({ ok: true });
        const ended = await endPush(pendingId);
        expect(ended.progress).toMatchObject({ outcomeLabel: "Stopped" });
        await settle();
        expect(agents.turnsStarted).toBe(0);
        expect(agents.fake.closed).toEqual(opening);
        expect(await agents.alive(opening[0] ?? "")).toBe(false);
      });

      it("ends a stopped build stopped and pushes Stopped even when its cleanup throws", async () => {
        agents.holdTurns();
        let closes = 0;
        handler = handlerWith({
          buildAgents: {
            open: agents.open,
            turn: agents.turn,
            alive: agents.alive,
            close: async (sessionName) => {
              closes += 1;
              if (closes === 1) throw new Error("close failed");
              return agents.close(sessionName);
            },
          },
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId("cleanup-throws");
        await vi.waitFor(() => {
          expect(agents.turnsStarted).toBe(1);
        });
        const [opened] = agents.fake.opened;
        if (opened === undefined) throw new Error("the build session never opened");

        const stopped = await handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });

        expect(stopped).toMatchObject({ ok: false, error: "close failed" });
        const ended = await endPush(pendingId);
        expect(ended.progress).toMatchObject({ outcomeLabel: "Stopped" });
        expect(runs.listPendingBuilds()).toEqual([]);
        expect(
          runs.listLatestEndedPendingBuildsByName().find((pending) => pending.id === pendingId)
            ?.outcome,
        ).toBe("stopped");
        expect(await new NodeFileSystem().exists(opened.workspaceDir)).toBe(false);
      });

      it("pushes Built · v1 with the build id when the session of a recorded build fails to close", async () => {
        handler = handlerWith({
          buildAgents: {
            open: agents.open,
            turn: agents.turn,
            alive: agents.alive,
            close: () => Promise.reject(new Error("close failed")),
          },
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId("close-throws");

        const ended = await endPush(pendingId);

        const [built] = runs.listBuilds();
        if (built === undefined) throw new Error("the build was not recorded");
        expect(ended.progress.chip).toBe("Built · v1");
        expect(ended.buildId).toBe(built.id);
        expect(runs.pendingBuild(pendingId)?.outcome).toBe("built");
        expect(runs.listLatestEndedPendingBuildsByName()).toEqual([]);
      });

      it("pushes Failed and leaves no open build when the build session fails to open", async () => {
        handler = handlerWith({
          buildAgents: {
            open: () => Promise.reject(new Error("open failed")),
            turn: agents.turn,
            alive: agents.alive,
            close: agents.close,
          },
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId("open-throws");

        const ended = await endPush(pendingId);

        expect(ended.progress).toMatchObject({ chip: "Failed", outcomeLabel: "Failed" });
        expect(runs.listPendingBuilds()).toEqual([]);
        expect(
          runs.listLatestEndedPendingBuildsByName().find((pending) => pending.id === pendingId)
            ?.outcome,
        ).toBe("failed");
        expect(runs.listBuilds()).toEqual([]);
      });

      it("appends no build events after a stop", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const asked: string[] = [];
        const writes = new NodeFileSystem();
        const fs: FileSystem = Object.assign(Object.create(writes) as NodeFileSystem, {
          writeFile: async (path: string, content: string) => {
            if (path.startsWith(join(home, "workspaces"))) {
              asked.push(path);
              await gate;
            }
            await writes.writeFile(path, content);
          },
        });
        handler = handlerWith({
          buildAgents: agents,
          fs,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId("no-events-after-stop");
        await vi.waitFor(() => {
          expect(asked).toHaveLength(1);
        });
        const eventsAtStop = runs.buildEvents(pendingId);

        const stopping = handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        release();
        expect(await stopping).toMatchObject({ ok: true });
        await endPush(pendingId);
        await settle();

        expect(runs.buildEvents(pendingId)).toEqual(eventsAtStop);
      });

      describe("delete-pending-build", () => {
        const deletePendingBuild = async (id: string) => {
          const response = await handler.handle({
            id: nextId++,
            type: "delete-pending-build",
            payload: { id },
          });
          expect(response).toMatchObject({ ok: true });
        };

        const progressIds = async () => {
          const listed = await handler.handle({ id: nextId++, type: "build-progress-list" });
          return (listed as { value: { pendingId: string }[] }).value.map(
            (entry) => entry.pendingId,
          );
        };

        const heldBuild = async () => {
          agents.holdTurns();
          const pendingId = await startedPendingId();
          await vi.waitFor(() => {
            expect(agents.turnsStarted).toBe(1);
          });
          const [opened] = agents.fake.opened;
          if (opened === undefined) throw new Error("the build session never opened");
          return { pendingId, opened };
        };

        it("stops a building row's build first, then removes the row and leaves no session or workspace folder", async () => {
          const { pendingId, opened } = await heldBuild();

          await deletePendingBuild(pendingId);

          expect(agents.fake.closed).toEqual([opened.sessionName]);
          expect(runs.pendingBuild(pendingId)).toBeNull();
          expect(await progressIds()).not.toContain(pendingId);
          expect(runs.listLatestEndedPendingBuildsByName().map((ended) => ended.id)).toEqual([]);
          expect(await new NodeFileSystem().exists(dirname(opened.settingsPath))).toBe(false);
          expect(await new NodeFileSystem().exists(opened.workspaceDir)).toBe(false);
        });

        it("removes the build-sessions folder a building row's stop left behind", async () => {
          class KeepsFirstSessionFolder extends NodeFileSystem {
            private kept = false;

            override async removeTree(path: string, keep?: { keep?: string[] }): Promise<void> {
              if (!this.kept && path.startsWith(join(home, "build-sessions"))) {
                this.kept = true;
                return;
              }
              return super.removeTree(path, keep);
            }
          }
          const fs = new KeepsFirstSessionFolder();
          handler = handlerWith({
            buildAgents: agents,
            fs,
            run: { ...runEnvironment(fs), usage },
          });
          const { pendingId, opened } = await heldBuild();

          await deletePendingBuild(pendingId);

          expect(await progressIds()).not.toContain(pendingId);
          expect(await new NodeFileSystem().exists(dirname(opened.settingsPath))).toBe(false);
        });

        it.each(["needs-you", "failed", "stopped"] as const)(
          "removes a row that ended %s, stopping nothing",
          async (outcome) => {
            const start = runs.startPendingBuild({
              flowId: "flow-1",
              version: 1,
              name: `ended-${outcome}`,
              origin: {
                source: { flowId: "flow-1", version: 1 },
                blueprint: { name: "Untitled", version: 1 },
              },
              startedAt: 1_000,
            });
            if (start.kind !== "started") throw new Error("the ended build did not start");
            runs.endPendingBuild(start.pendingId, { outcome, endedAt: 2_000 });
            expect(await progressIds()).toContain(start.pendingId);

            await deletePendingBuild(start.pendingId);

            expect(await progressIds()).not.toContain(start.pendingId);
            expect(runs.listLatestEndedPendingBuildsByName()).toEqual([]);
            expect(runs.pendingBuild(start.pendingId)).toBeNull();
            expect(agents.fake.closed).toEqual([]);
          },
        );

        describe("an ended row whose build left its worktree", () => {
          const keptPath = (name: string) => `/fd-home/workspaces/b-${name}/sessions/main/app`;
          const sessionFolder = (name: string) => `/fd-home/build-sessions/fd-build-${name}`;

          const endedRow = (name: string, { session = true } = {}) => {
            const start = runs.startPendingBuild({
              flowId: "flow-1",
              version: 1,
              name,
              origin: {
                source: { flowId: "flow-1", version: 1 },
                blueprint: { name: "Untitled", version: 1 },
              },
              startedAt: 1_000,
            });
            if (start.kind !== "started") throw new Error("the ended build did not start");
            if (session) {
              runs.addBuildWorktree(`b-${name}`, {
                container: "main",
                repo: "/repos/app",
                base: "main",
                branch: `flowdeck/${name}`,
                branchCreated: true,
                path: keptPath(name),
              });
              runs.appendBuildEvent(start.pendingId, {
                type: "session",
                name: `fd-build-${name}`,
                claudeSessionId: `claude-${name}`,
                buildId: `b-${name}`,
                repo: "/repos/app",
                base: "main",
                values: {},
                branch: `flowdeck/${name}`,
                branchCreated: true,
              });
            }
            runs.endPendingBuild(start.pendingId, { outcome: "failed", endedAt: 2_000 });
            return start.pendingId;
          };

          const leftOnDisk = (...names: string[]) =>
            new FakeFileSystem(
              Object.fromEntries(
                names.flatMap((name) => [
                  [`${keptPath(name)}/work.txt`, "kept\n"],
                  [`${sessionFolder(name)}/settings.json`, "{}"],
                ]),
              ),
            );

          const preview = (id: string) =>
            handler.handle({ id: nextId++, type: "delete-pending-preview", payload: { id } });

          it("previews the uncommitted or unpushed work deleting it would lose", async () => {
            handler = handlerWith({
              home: "/fd-home",
              fs: leftOnDisk("dirty", "unpushed"),
              worktree: new FakeWorktree({
                dirty: [keptPath("dirty")],
                unpushed: ["flowdeck/unpushed", "flowdeck/torn-down"],
              }),
            });
            const dirty = endedRow("dirty");
            const unpushed = endedRow("unpushed");
            const tornDown = endedRow("torn-down");
            const sessionless = endedRow("sessionless", { session: false });

            expect(await preview(dirty)).toMatchObject({
              ok: true,
              value: { dirtyWorktree: true, unpushedBranch: false },
            });
            expect(await preview(unpushed)).toMatchObject({
              ok: true,
              value: { dirtyWorktree: false, unpushedBranch: true },
            });
            expect(await preview(tornDown)).toMatchObject({
              ok: true,
              value: { dirtyWorktree: false, unpushedBranch: false },
            });
            expect(await preview(sessionless)).toMatchObject({
              ok: true,
              value: { dirtyWorktree: false, unpushedBranch: false },
            });
            expect(runs.pendingBuild(dirty)).not.toBeNull();
          });

          it("removes the kept worktree with its work, the workspace and the session folder", async () => {
            const fs = leftOnDisk("kept");
            const worktree = new FakeWorktree({
              dirty: [keptPath("kept")],
              unpushed: ["flowdeck/kept"],
            });
            handler = handlerWith({ home: "/fd-home", fs, worktree });
            const id = endedRow("kept");

            await deletePendingBuild(id);

            expect(worktree.removed).toEqual([
              expect.objectContaining({ path: keptPath("kept"), force: true }),
            ]);
            expect(await fs.exists("/fd-home/workspaces/b-kept")).toBe(false);
            expect(await fs.exists(sessionFolder("kept"))).toBe(false);
            expect(runs.pendingBuild(id)).toBeNull();
            expect(runs.buildEvents(id)).toEqual([]);
          });

          it("touches no folder for a row whose build never opened a session", async () => {
            const fs = new FakeFileSystem();
            handler = handlerWith({ home: "/fd-home", fs, worktree: new FakeWorktree() });
            const id = endedRow("sessionless", { session: false });

            await deletePendingBuild(id);

            expect(fs.calls.filter((call) => call.method === "removeTree")).toEqual([]);
            expect(runs.pendingBuild(id)).toBeNull();
          });
        });
      });

      describe("build-rebuild", () => {
        const question = { nodeId: "write", text: "Who writes notes.md?", otherNodeId: "check" };
        const questions = [question];
        const firstAnswer = { ...question, answer: "write writes notes.md; check reads it." };
        const secondAnswer = {
          nodeId: "check",
          text: "Should check fail on an empty notes.md?",
          answer: "Yes, an empty notes.md fails the check.",
        };

        const asking = () => {
          agents = new WatchedBuildAgents(() => undefined, { questions });
          handler = handlerWith({
            buildAgents: agents,
            run: { ...runEnvironment(new NodeFileSystem()), usage },
          });
        };

        const rebuild = (payload: unknown) =>
          handler.handle({ id: nextId++, type: "build-rebuild" as never, payload });

        const rebuiltPendingId = async (pendingId: string, answers: unknown[]) => {
          const answered = await rebuild({ pendingId, answers });
          expect(answered).toMatchObject({
            ok: true,
            value: { kind: "started", pendingId: expect.any(String) },
          });
          return (answered as { value: { pendingId: string } }).value.pendingId;
        };

        const stepThreeTurnOf = (sessionIndex: number) => {
          const sessionName = agents.fake.opened[sessionIndex]?.sessionName;
          return agents.fake.turns.find((turn) => turn.sessionName === sessionName)?.text ?? "";
        };

        const firstRequest = () => ({ repo: repo.path, base: "main", buildModel: "haiku" });

        const askedBuild = async () => {
          const answered = await handler.handle({
            id: nextId++,
            type: "build-version",
            payload: {
              flowId: "flow-1",
              version: 1,
              name: "fix-login",
              values: {},
              ...firstRequest(),
            },
          });
          expect(answered).toMatchObject({ ok: true, value: { kind: "started" } });
          const { pendingId } = (answered as { value: { pendingId: string } }).value;
          expect((await endPush(pendingId)).progress.chip).toBe("Needs you");
          return pendingId;
        };

        const refusal = (response: unknown) => {
          const answered = response as
            { ok: true; value?: { kind?: string } } | { ok: false; error?: unknown } | undefined;
          if (answered === undefined) return false;
          return answered.ok
            ? answered.value?.kind === "error"
            : typeof answered.error === "string";
        };

        it("starts a new build of the same blueprint, version and name, with the old inputs and the answers so far, and leaves the old build as it was", async () => {
          asking();
          const asked = await askedBuild();
          const askedRow = runs
            .listLatestEndedPendingBuildsByName()
            .find((row) => row.id === asked);

          const first = await rebuiltPendingId(asked, [firstAnswer]);
          await endPush(first);

          expect(first).not.toBe(asked);
          expect(runs.pendingBuild(asked)).toEqual(askedRow);
          expect(runs.pendingBuild(first)).toMatchObject({
            flowId: "flow-1",
            version: 1,
            name: "fix-login",
            outcome: "needs-you",
            origin: { request: { values: {}, ...firstRequest(), answers: [firstAnswer] } },
          });
          expect(agents.fake.opened.map((spec) => spec.model)).toEqual(["haiku", "haiku"]);
          expect(stepThreeTurnOf(0)).not.toContain(firstAnswer.answer);
          expect(stepThreeTurnOf(1)).toContain(firstAnswer.text);
          expect(stepThreeTurnOf(1)).toContain(firstAnswer.answer);

          const second = await rebuiltPendingId(first, [secondAnswer]);
          await endPush(second);

          expect(runs.pendingBuild(second)).toMatchObject({
            name: "fix-login",
            origin: {
              request: { values: {}, ...firstRequest(), answers: [firstAnswer, secondAnswer] },
            },
          });
          expect(stepThreeTurnOf(2)).toContain(firstAnswer.answer);
          expect(stepThreeTurnOf(2)).toContain(secondAnswer.answer);
        });

        it("starts the rebuild from the blueprint version the asked build names, under its snapshot's name, and gives it the same snapshot", async () => {
          asking();
          const asked = await askedBuild();
          const askedSnapshot = runs.buildSnapshot({ pendingId: asked });
          expect(askedSnapshot).not.toBeNull();
          flows.rename("flow-1", "Renamed since");
          const saved = flows.load({ flowId: "flow-1", version: 1 });
          if (saved === null) throw new Error("version 1 is not saved");
          flows.save(
            { ...saved.flow, nodes: saved.flow.nodes.filter((node) => node.id !== "check") },
            "flow-1",
          );
          const loaded = vi.spyOn(flows, "load");

          const first = await rebuiltPendingId(asked, [firstAnswer]);
          await endPush(first);

          expect(loaded).toHaveBeenCalledWith({ flowId: "flow-1", version: 1 });
          expect(runs.buildSnapshot({ pendingId: first })).toEqual({
            ...askedSnapshot,
            pendingId: first,
            buildId: null,
          });
          expect(runs.pendingBuild(first)).toMatchObject({
            flowId: "flow-1",
            version: 1,
            name: "fix-login",
            origin: {
              source: { flowId: "flow-1", version: 1 },
              blueprint: {
                name: askedSnapshot?.blueprintName,
                version: askedSnapshot?.version,
              },
              request: { values: {}, ...firstRequest(), answers: [firstAnswer] },
            },
          });
          expect(stepThreeTurnOf(1)).toContain(firstAnswer.answer);
        });

        it("rebuilds from the flow the asked build froze, not from the library's later save", async () => {
          asking();
          const library = flows.save(nodeLibrary("Planner"), { name: "Android" });
          const host = atRepo(
            onWorkspaceMainFlow(
              [agent("write"), agent("check"), libraryUse(library.flowId)],
              [thenWire("write", "check"), thenWire("check", "use")],
            ),
          );
          const { version } = flows.save(host, "flow-1");
          const answered = await handler.handle({
            id: nextId++,
            type: "build-version",
            payload: {
              flowId: "flow-1",
              version,
              name: "fix-login",
              values: {},
              ...firstRequest(),
            },
          });
          expect(answered).toMatchObject({ ok: true, value: { kind: "started" } });
          const asked = (answered as { value: { pendingId: string } }).value.pendingId;
          expect((await endPush(asked)).progress.chip).toBe("Needs you");
          flows.save(nodeLibrary("Reviewer"), library.flowId);

          const first = await rebuiltPendingId(asked, [firstAnswer]);
          await endPush(first);

          expect(labelOf(runs.buildSnapshot({ pendingId: asked })?.flow, "android-app-plan")).toBe(
            "Planner",
          );
          expect(labelOf(runs.buildSnapshot({ pendingId: first })?.flow, "android-app-plan")).toBe(
            "Planner",
          );
        });

        it.each([
          { blueprints: "has no such version", load: () => null },
          { blueprints: "cannot be read", load: unreadable },
        ])(
          "refuses the rebuild and starts nothing when the blueprint store $blueprints",
          async ({ load }) => {
            asking();
            const asked = await askedBuild();
            vi.spyOn(flows, "load").mockImplementation(load);

            const refused = await rebuild({ pendingId: asked, answers: [firstAnswer] });

            expect(refusal(refused)).toBe(true);
            await settle();
            expect(runs.listPendingBuilds()).toEqual([]);
            expect(runs.listLatestEndedPendingBuildsByName().map((ended) => ended.id)).toEqual([
              asked,
            ]);
            expect(agents.fake.opened).toHaveLength(1);
          },
        );

        it("keeps a built build's run, its list entry and a needs-you rebuild working after its blueprint is deleted", async () => {
          const ended = await endPush(await startedPendingId("kept"));
          const { buildId } = ended;
          if (buildId === undefined) throw new Error("the build did not end built");
          const runId = await startedOn(buildId);
          await untilFinished(runId);
          asking();
          const asked = await askedBuild();

          expect(
            await handler.handle({
              id: nextId++,
              type: "delete-flow",
              payload: { flowId: "flow-1" },
            }),
          ).toMatchObject({ ok: true });

          expect(
            await handler.handle({ id: nextId++, type: "load-run", payload: { runId } }),
          ).toMatchObject({ ok: true, value: { run: { id: runId }, name: "kept" } });
          const listed = await handler.handle({ id: nextId++, type: "list-builds" });
          expect((listed as { value: unknown[] }).value).toContainEqual(
            expect.objectContaining({
              id: buildId,
              blueprintName: "Untitled",
              blueprintVersion: 1,
            }),
          );
          const rebuilt = await rebuiltPendingId(asked, [firstAnswer]);
          await endPush(rebuilt);
          expect(runs.pendingBuild(rebuilt)).toMatchObject({ flowId: "flow-1", version: 1 });
        });

        it("refuses a needs-you build that has no snapshot, naming it, and starts nothing", async () => {
          await handler.handle({ id: nextId++, type: "store-status" });
          const start = runs.startPendingBuild({
            flowId: "flow-1",
            version: 1,
            name: "no-snapshot",
            origin: {
              source: { flowId: "flow-1", version: 1 },
              blueprint: { name: "Untitled", version: 1 },
              request: { values: {}, ...firstRequest() },
            },
            startedAt: 1_000,
          });
          if (start.kind !== "started") throw new Error("the old build did not start");
          runs.endPendingBuild(start.pendingId, {
            outcome: "needs-you",
            endedAt: 2_000,
            report: { version: 1, questions },
          });

          const refused = await rebuild({ pendingId: start.pendingId, answers: [firstAnswer] });

          expect(refusal(refused)).toBe(true);
          expect(refused).toMatchObject({ error: expect.stringContaining("no-snapshot") });
          await settle();

          expect(runs.listPendingBuilds()).toEqual([]);
          expect(runs.listLatestEndedPendingBuildsByName().map((ended) => ended.id)).toEqual([
            start.pendingId,
          ]);
          expect(agents.fake.opened).toEqual([]);
        });

        it("refuses an unknown build, an empty answer, and no answers, starting nothing", async () => {
          asking();
          const asked = await askedBuild();
          const opened = agents.fake.opened.length;

          for (const payload of [
            { pendingId: "missing", answers: [firstAnswer] },
            { pendingId: asked, answers: [{ ...firstAnswer, answer: "   " }] },
            { pendingId: asked, answers: [] },
          ]) {
            expect(refusal(await rebuild(payload)), JSON.stringify(payload)).toBe(true);
          }
          await settle();

          expect(runs.listPendingBuilds()).toEqual([]);
          expect(runs.listLatestEndedPendingBuildsByName().map((ended) => ended.id)).toEqual([
            asked,
          ]);
          expect(agents.fake.opened).toHaveLength(opened);
        });

        it("refuses a build that ended built, starting nothing", async () => {
          const built = await startedPendingId("built-already");
          expect((await endPush(built)).progress.chip).toBe("Built · v1");
          const opened = agents.fake.opened.length;

          expect(refusal(await rebuild({ pendingId: built, answers: [firstAnswer] }))).toBe(true);
          await settle();

          expect(runs.listPendingBuilds()).toEqual([]);
          expect(runs.pendingBuild(built)?.outcome).toBe("built");
          expect(runs.listLatestEndedPendingBuildsByName()).toEqual([]);
          expect(agents.fake.opened).toHaveLength(opened);
        });

        it("refuses a build still going, starting nothing", async () => {
          agents.holdTurns();
          const going = await startedPendingId("still-going");
          try {
            await vi.waitFor(() => {
              expect(agents.turnsStarted).toBe(1);
            });

            expect(refusal(await rebuild({ pendingId: going, answers: [firstAnswer] }))).toBe(true);
            await settle();

            expect(runs.listPendingBuilds().map((open) => open.id)).toEqual([going]);
            expect(agents.fake.opened).toHaveLength(1);
          } finally {
            await handler.handle({
              id: nextId++,
              type: "build-stop",
              payload: { pendingId: going },
            });
          }
        });

        it("refuses a build that asked before builds kept their inputs, starting nothing", async () => {
          const start = runs.startPendingBuild({
            flowId: "flow-1",
            version: 1,
            name: "asked-before",
            origin: {
              source: { flowId: "flow-1", version: 1 },
              blueprint: { name: "Untitled", version: 1 },
            },
            startedAt: 1_000,
          });
          if (start.kind !== "started") throw new Error("the old build did not start");
          runs.endPendingBuild(start.pendingId, {
            outcome: "needs-you",
            endedAt: 2_000,
            report: { version: 1, questions },
          });

          expect(
            refusal(await rebuild({ pendingId: start.pendingId, answers: [firstAnswer] })),
          ).toBe(true);
          await settle();

          expect(runs.listPendingBuilds()).toEqual([]);
          expect(runs.listLatestEndedPendingBuildsByName().map((ended) => ended.id)).toEqual([
            start.pendingId,
          ]);
          expect(agents.fake.opened).toEqual([]);
        });

        it.each(["failed", "stopped"] as const)(
          "refuses a build that ended %s although it kept its inputs and its questions, starting nothing",
          async (outcome) => {
            const start = runs.startPendingBuild({
              flowId: "flow-1",
              version: 1,
              name: `ended-${outcome}`,
              origin: {
                source: { flowId: "flow-1", version: 1 },
                blueprint: { name: "Untitled", version: 1 },
                request: { values: {}, ...firstRequest() },
              },
              startedAt: 1_000,
            });
            if (start.kind !== "started") throw new Error("the ended build did not start");
            runs.endPendingBuild(start.pendingId, {
              outcome,
              endedAt: 2_000,
              report: {
                version: 1,
                questions: [{ nodeId: firstAnswer.nodeId, text: firstAnswer.text }],
                merges: [],
                keptApart: [],
                mixedJobs: [],
                pieces: [],
                needs: [],
                shared: [],
              },
            });

            const refused = await rebuild({ pendingId: start.pendingId, answers: [firstAnswer] });

            expect(refusal(refused)).toBe(true);
            expect(refused).toMatchObject({
              error: expect.stringContaining("did not end needing answers"),
            });
            await settle();

            expect(runs.listPendingBuilds()).toEqual([]);
            expect(runs.listLatestEndedPendingBuildsByName().map((ended) => ended.id)).toEqual([
              start.pendingId,
            ]);
            expect(agents.fake.opened).toEqual([]);
          },
        );

        it("keeps the request's branch in its origin and builds the rebuild on it", async () => {
          asking();
          const branch = { mode: "new", name: "flowdeck/notes", base: "main" };
          const answered = await handler.handle({
            id: nextId++,
            type: "build-version",
            payload: {
              flowId: "flow-1",
              version: 1,
              name: "fix-login",
              values: {},
              ...firstRequest(),
              branch,
            },
          });
          const { pendingId: asked } = (answered as { value: { pendingId: string } }).value;
          expect((await endPush(asked)).progress.chip).toBe("Needs you");
          expect(runs.pendingBuild(asked)?.origin).toMatchObject({
            request: { ...firstRequest(), branch },
          });

          const rebuilt = await rebuiltPendingId(asked, [firstAnswer]);
          await endPush(rebuilt);

          expect(runs.pendingBuild(rebuilt)?.origin).toMatchObject({
            request: { values: {}, ...firstRequest(), branch, answers: [firstAnswer] },
          });
          expect(runs.buildEvents(rebuilt).find((event) => event.type === "session")).toMatchObject(
            { branch: "flowdeck/notes", branchCreated: true },
          );
        });

        it("keeps a build-version request's inputs in its origin, and takes no answers from it", async () => {
          const answered = await handler.handle({
            id: nextId++,
            type: "build-version",
            payload: {
              flowId: "flow-1",
              version: 1,
              name: "no-answers",
              values: {},
              ...firstRequest(),
              answers: [firstAnswer],
            },
          });
          expect(answered).toMatchObject({ ok: true, value: { kind: "started" } });
          const { pendingId } = (answered as { value: { pendingId: string } }).value;
          await endPush(pendingId);

          const ended = runs.pendingBuild(pendingId);
          const request = (ended?.origin as { request?: unknown } | undefined)?.request;
          expect(request).toEqual({ values: {}, ...firstRequest() });
          expect(stepThreeTurnOf(0)).not.toContain(firstAnswer.answer);
        });
      });
    });

    describe("delete-build", () => {
      const deleteBuild = async (buildId: string) => {
        const response = await handler.handle({
          id: nextId++,
          type: "delete-build",
          payload: { buildId },
        });
        expect(response).toMatchObject({ ok: true });
        return (response as { value: unknown }).value;
      };

      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

      const silentNarrator = () => new FakeRunNarrator({ text: "Told.", cost: 0.25 });

      const expectNoStory = async (narrator: FakeRunNarrator, runId: string) => {
        await settle();
        expect(narrator.calls).toEqual([]);
        expect(pushes).not.toContainEqual({ push: "story", runId });
      };

      const runningRefusal = {
        ok: false,
        message: "This build has a run left going. Stop or resume it first.",
      };

      it("refuses to delete a build while its run is going, leaving the run going and the build in place", async () => {
        const narrator = silentNarrator();
        const worktree = new FakeWorktree();
        handler = handlerWith({ narrator, worktree });
        flows.save(sleeper());
        const buildId = await builtId();
        const runId = await startedOn(buildId);
        await vi.waitFor(() => {
          expect(snapshotsOf(runId).at(-1)?.nodes["nap"]).toBe("sent");
        });

        expect(await deleteBuild(buildId)).toEqual(runningRefusal);

        expect(runs.findRun(runId)?.status).toBe("running");
        expect(snapshotsOf(runId).at(-1)?.status).toBe("running");
        expect(runs.listBuilds().map((build) => build.id)).toEqual([buildId]);
        expect(worktree.removed).toEqual([]);
        await expectNoStory(narrator, runId);
      });

      it("lets a starting run start, then refuses to delete its build, leaving the run going", async () => {
        flows.save(sleeper());
        const buildId = await builtId();

        const starting = handler.handle({ id: nextId++, type: "run-build", payload: { buildId } });
        const deleting = deleteBuild(buildId);

        expect(await deleting).toEqual(runningRefusal);
        expect(await starting).toMatchObject({ value: { kind: "started" } });
        expect(runs.runs.map((run) => run.status)).toEqual(["running"]);
        expect(runs.listBuilds().map((build) => build.id)).toEqual([buildId]);
      });

      it("refuses to delete a build whose run was left going, ending no session", async () => {
        const ended: string[] = [];
        handler = handlerWith({
          sessionAlive: async (name) => name === "fd-run-left",
          endSession: async (name) => {
            ended.push(name);
          },
        });
        flows.save(sleeper());
        const buildId = await builtId();
        const runId = runs.createRun({
          buildDir: buildDirOf(buildId),
          inputs: {},
          nodeIds: ["start"],
          session: { tmuxName: "fd-run-left", cwd: repo.path, claudeSessionId: "c-left" },
          buildId,
        }).id;

        expect(await deleteBuild(buildId)).toEqual(runningRefusal);

        expect(ended).toEqual([]);
        expect(runs.findRun(runId)?.status).toBe("running");
        expect(runs.listBuilds().map((build) => build.id)).toEqual([buildId]);
      });

      it("removes the folder of the build's last build session when it deletes the build", async () => {
        flows.save(twoAgents());
        const buildId = await builtId();
        const pendingId = pushes.findLast(
          (push): push is Extract<EnginePush, { push: "build-progress" }> =>
            push.push === "build-progress" && push.buildId === buildId,
        )?.pendingId;
        if (pendingId === undefined) throw new Error(`no build progress names ${buildId}`);
        const session = runs.buildEvents(pendingId).findLast((event) => event.type === "session");
        if (session?.type !== "session") throw new Error(`build ${buildId} has no session`);
        const sessionFolder = join(home, "build-sessions", session.name);
        const otherFolder = join(home, "build-sessions", "fd-build-other");
        await mkdir(sessionFolder, { recursive: true });
        await writeFile(join(sessionFolder, "settings.json"), "{}");
        await mkdir(otherFolder, { recursive: true });

        expect(await deleteBuild(buildId)).toEqual({ ok: true });

        await expect(stat(sessionFolder)).rejects.toThrow();
        expect(await readdir(join(home, "build-sessions"))).toEqual(["fd-build-other"]);
      });

      it("removes the build's Claude project folders and .claude.json entries from the configured Claude config", async () => {
        const workspace = "/fd-home/workspaces/build-claude";
        const projectFolder = "-fd-home-workspaces-build-claude";
        const fs = new FakeFileSystem({
          [`/claude/projects/${projectFolder}/s.jsonl`]: "{}",
          [`/claude/projects/${projectFolder}-app/s.jsonl`]: "{}",
          ["/claude/projects/-work-app/s.jsonl"]: "{}",
          ["/claude/.claude.json"]: JSON.stringify({
            numStartups: 3,
            projects: { [workspace]: {}, [`${workspace}/app`]: {}, "/work/app": {} },
          }),
        });
        handler = handlerWith({
          home: "/fd-home",
          fs,
          claudeConfig: {
            projectsDir: "/claude/projects",
            claudeJson: "/claude/.claude.json",
          },
        });
        runs.recordBuild({
          id: "build-claude",
          hash: "hash-claude",
          name: "claude",
          repo: "/repos/app",
          base: "main",
          branch: "flowdeck/claude",
          branchCreated: false,
          values: {},
          dir: workspace,
          source: { flowId: "flow-1", version: 1 },
          files: [],
          nodes: [],
          manifest: "{}",
        });

        expect(await deleteBuild("build-claude")).toEqual({ ok: true });

        expect(await fs.folders("/claude/projects")).toEqual(["-work-app"]);
        expect(JSON.parse(await fs.readFile("/claude/.claude.json"))).toEqual({
          numStartups: 3,
          projects: { "/work/app": {} },
        });
      });

      it("asks the configured pull requests source before deleting a branch it made, keeping one with an open PR", async () => {
        const worktree = new FakeWorktree();
        const pullRequests = new FakePullRequests({ "flowdeck/pr": "open" });
        handler = handlerWith({
          home: "/fd-home",
          fs: new FakeFileSystem(),
          worktree,
          pullRequests,
        });
        runs.recordBuild({
          id: "build-pr",
          hash: "hash-pr",
          name: "pr",
          repo: "/repos/app",
          base: "main",
          branch: "flowdeck/pr",
          branchCreated: true,
          values: {},
          dir: "/fd-home/workspaces/build-pr",
          source: { flowId: "flow-1", version: 1 },
          files: [],
          nodes: [],
          manifest: "{}",
        });
        runs.addBuildWorktree("build-pr", {
          container: "main",
          repo: "/repos/app",
          base: "main",
          branch: "flowdeck/pr",
          branchCreated: true,
          path: "/fd-home/workspaces/build-pr/sessions/main/app",
        });

        expect(await deleteBuild("build-pr")).toEqual({
          ok: true,
          kept: [{ kind: "branch", branch: "flowdeck/pr", reason: "open-pr" }],
        });

        expect(pullRequests.calls).toEqual([{ repo: "/repos/app", branch: "flowdeck/pr" }]);
        expect(worktree.deletedRemoteBranches).toEqual([]);
      });

      it("previews whether deleting the build loses work in its worktree", async () => {
        const source = await createTmpRepo({ commit: true });
        try {
          handler = handlerWith({ worktree: new GitWorktree(), gitState: gitAt(source.path) });
          flows.save(inFolder(twoAgents(), { repo: source.path, base: "main" }));
          const buildId = await builtId();
          const preview = () =>
            handler.handle({ id: nextId++, type: "delete-preview", payload: { buildId } });

          expect(await preview()).toMatchObject({
            ok: true,
            value: { dirtyWorktree: false, unpushedBranch: false },
          });
          await writeFile(join(worktreeOf(buildId, source.path), "work.txt"), "kept\n");
          expect(await preview()).toMatchObject({
            ok: true,
            value: { dirtyWorktree: true, unpushedBranch: false },
          });
          expect(runs.listBuilds().map((build) => build.id)).toEqual([buildId]);
        } finally {
          await source.cleanup();
        }
      });

      it("refuses a run of the build while its delete is going, and creates no run", async () => {
        let release: () => void = () => undefined;
        const checked = new Promise<void>((resolve) => {
          release = resolve;
        });
        class SlowWorktree extends FakeWorktree {
          override async isDirty(path: string): Promise<boolean> {
            await checked;
            return super.isDirty(path);
          }
        }
        handler = handlerWith({ worktree: new SlowWorktree() });
        flows.save(twoAgents());
        const buildId = await builtId();

        const deleting = deleteBuild(buildId);
        const running = runBuild(buildId);
        const refused = await running;
        release();

        expect(refused).toEqual({ kind: "error", message: expect.any(String) });
        expect(await deleting).toEqual({ ok: true });
        expect(runs.runs).toHaveLength(0);
      });

      it("still answers a finished run's cost per stage from the stored manifest once the build is deleted and its folder is gone", async () => {
        flows.save(twoAgents());
        const buildId = await builtId();
        const dir = buildDirOf(buildId);
        const runId = await startedOn(buildId);
        await untilFinished(runId);
        expect(await deleteBuild(buildId)).toEqual({ ok: true });
        await rm(dir, { recursive: true, force: true });

        const answered = await handler.handle({
          id: nextId++,
          type: "run-cost",
          payload: { runId },
        });

        expect(answered).toEqual(expect.objectContaining({ ok: true }));
        const report = (answered as { value: { nodes: { nodeId: string }[] } }).value;
        expect(report.nodes.map((line) => line.nodeId)).toEqual([
          "start",
          "write",
          "check",
          "stop",
          "session-1-start",
          "session-1-stop",
        ]);
      });

      const deletedBuildRefusal = (buildId: string) => ({
        kind: "error",
        message: `No build ${buildId}`,
      });

      it("refuses to resume a stopped run of a deleted build, opening no session and writing nothing", async () => {
        flows.save(sleeper());
        const buildId = await builtId();
        const runId = await startedOn(buildId);
        await vi.waitFor(() => {
          expect(snapshotsOf(runId).at(-1)?.nodes["nap"]).toBe("sent");
        });
        await handler.handle({ id: nextId++, type: "stop-run", payload: { runId } });
        await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("stopped"));
        expect(await deleteBuild(buildId)).toEqual({ ok: true });
        const sessionsBefore = sessionPushes(runId).length;
        const eventsBefore = runs.events(runId).length;

        expect(
          await handler.handle({ id: nextId++, type: "resume-run", payload: { runId } }),
        ).toMatchObject({ ok: true, value: deletedBuildRefusal(buildId) });
        expect(sessionPushes(runId)).toHaveLength(sessionsBefore);
        expect(runs.events(runId)).toHaveLength(eventsBefore);
        expect(runs.findRun(runId)?.status).toBe("stopped");
      });

      it("refuses to retry a stage of a deleted build's run, opening no session and writing nothing", async () => {
        flows.save(twoAgents());
        const buildId = await builtId();
        const runId = await startedOn(buildId);
        await untilFinished(runId);
        expect(await deleteBuild(buildId)).toEqual({ ok: true });
        const sessionsBefore = sessionPushes(runId).length;
        const eventsBefore = runs.events(runId).length;
        const statusBefore = runs.findRun(runId)?.status;

        expect(
          await handler.handle({
            id: nextId++,
            type: "retry-node",
            payload: { runId, nodeId: "write" },
          }),
        ).toMatchObject({ ok: true, value: deletedBuildRefusal(buildId) });
        expect(sessionPushes(runId)).toHaveLength(sessionsBefore);
        expect(runs.events(runId)).toHaveLength(eventsBefore);
        expect(runs.findRun(runId)?.status).toBe(statusBefore);
      });

      it("refuses a run of a deleted build and creates no run for it", async () => {
        flows.save(twoAgents());
        const buildId = await builtId();
        expect(await deleteBuild(buildId)).toEqual({ ok: true });

        expect(await runBuild(buildId)).toEqual({
          kind: "error",
          message: `No build ${buildId}`,
        });
        expect(runs.runs).toHaveLength(0);
      });

      it("deletes the build and removes a worktree that holds work", async () => {
        const source = await createTmpRepo({ commit: true });
        try {
          handler = handlerWith({ worktree: new GitWorktree(), gitState: gitAt(source.path) });
          flows.save(inFolder(twoAgents(), { repo: source.path, base: "main" }));
          const buildId = await builtId();
          const worktree = worktreeOf(buildId, source.path);
          await writeFile(join(worktree, "work.txt"), "kept\n");

          expect(await deleteBuild(buildId)).toEqual({ ok: true });
          await expect(stat(worktree)).rejects.toThrow();
          expect(await handler.handle({ id: nextId++, type: "list-builds" })).toMatchObject({
            value: [],
          });
        } finally {
          await source.cleanup();
        }
      });
    });

    describe("a build with a worktree per session container", () => {
      const twoSessions = () =>
        sessionsWorkflow([
          { name: "android", repo: repo.path, branch: "main" },
          { name: "ios", repo: repo.path, branch: "main" },
        ]);

      const containerWorktrees = (buildId: string) => {
        const dir = buildDirOf(buildId);
        return [sessionWorktree(dir, "android", repo.path), sessionWorktree(dir, "ios", repo.path)];
      };

      const answer = async (type: string, payload: unknown) => {
        const response = await handler.handle({
          id: nextId++,
          type: type as Parameters<typeof handler.handle>[0]["type"],
          payload,
        });
        expect(response).toMatchObject({ ok: true });
        return (response as { value: unknown }).value;
      };

      const pendingIdOf = (buildId: string) => {
        const pendingId = pushes.findLast(
          (push): push is Extract<EnginePush, { push: "build-progress" }> =>
            push.push === "build-progress" && push.buildId === buildId,
        )?.pendingId;
        if (pendingId === undefined) throw new Error(`no build progress names ${buildId}`);
        return pendingId;
      };

      describe("run workspace-first", () => {
        type Group = PipelineGroup;
        type Pushed = { container: string; tmuxName: string };

        let claude: ReturnType<typeof fakeClaudeSession>;
        let release: () => void;
        let alive: Set<string>;
        let ended: string[];

        const workspaceFirst = (): Flow => {
          const built = sessionsWorkflow(
            [
              { name: "android", repo: repo.path, branch: "main", model: "haiku" },
              { name: "ios", repo: repo.path, branch: "main", model: "sonnet" },
            ],
            { workspace: ["Wait"] },
          );
          return {
            ...built,
            containers: built.containers.map((container) =>
              container.kind === "workspace" ? { ...container, model: "opus" } : container,
            ),
          };
        };

        const runHandler = (
          overrides: Partial<EngineHandlerOptions> = {},
          extra: { permissions?: FakePermissionSource; usage?: FakeUsageSource } = {},
        ) => {
          let released: () => void = () => undefined;
          const workspaceWaits = new Promise<void>((resolve) => (released = resolve));
          release = released;
          claude = fakeClaudeSession(async (nodeId) => {
            if (nodeId === "workspace-1-wait") await workspaceWaits;
            return "done" as const;
          });
          handler = handlerWith({
            run: {
              ...runEnvironment(new NodeFileSystem()),
              startEvents: async () => ({
                events: claude.events,
                ...(extra.permissions === undefined ? {} : { permissions: extra.permissions }),
                stop: async () => undefined,
              }),
              openSession: claude.openSession,
              ...(extra.usage === undefined ? {} : { usage: extra.usage }),
            },
            sessionAlive: async (name) => alive.has(name),
            endSession: async (name) => {
              ended.push(name);
              alive.delete(name);
            },
            ...overrides,
          });
        };

        const sessionOf = (env: Record<string, string>, slug: string) => ({
          tmuxName: env[`FD_SESSION_${slug}_TMUX`] ?? "",
          claudeSessionId: env[`FD_SESSION_${slug}_ID`] ?? "",
        });

        const startWorkspaceFirst = async () => {
          flows.save(workspaceFirst());
          const buildId = await builtId();
          const runId = await startedOn(buildId);
          await vi.waitFor(() => expect(claude.sentTo("workspace-1-wait")).toHaveLength(1));
          const workspace = claude.opened[0];
          if (workspace === undefined) throw new Error("no workspace session opened");
          const env = (workspace as OpenSessionOptions & { env?: Record<string, string> }).env;
          return {
            buildId,
            runId,
            workspace,
            env: env ?? {},
            android: sessionOf(env ?? {}, "ANDROID"),
            ios: sessionOf(env ?? {}, "IOS"),
          };
        };

        const hook = (sessionId: string, kind: HookEventKind, payload: object = {}) =>
          claude.events.publish({
            kind,
            sessionId,
            payload: {
              hook_event_name: kind,
              session_id: sessionId,
              flowdeck_hook_at: Date.now(),
              ...payload,
            },
          });

        const agentCall = (nodeId: string, type = "agent") => ({
          tool_name: "Agent",
          tool_input: { subagent_type: type, prompt: `NODE ${nodeId}\nGo` },
          tool_use_id: `toolu-${nodeId}`,
        });

        const agentDone = (nodeId: string, type = "agent") => ({
          ...agentCall(nodeId, type),
          tool_response: {
            status: "completed",
            agentId: `agent-${nodeId}`,
            agentType: type,
            content: [{ type: "text", text: `${nodeId} done` }],
          },
        });

        const statusOf = (runId: string, nodeId: string) =>
          nodeStatus(runs.events(runId).filter((event) => event.nodeId === nodeId));

        const endOf = async (runId: string) => {
          await vi.waitFor(() => expect(runs.findRun(runId)?.status).not.toBe("running"), {
            timeout: 5000,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
          return runs.findRun(runId)?.status;
        };

        const groupsOf = async (runId: string) =>
          (await answer("run-pipeline", { runId })) as Group[];

        const groupOf = (groups: Group[], name: string) => {
          const found = groups.find((group) => group.name === name);
          if (found === undefined) throw new Error(`no ${name} group`);
          return found;
        };

        const statusesOf = (group: Group) =>
          Object.fromEntries(
            group.items.flatMap((item) => ("nodeId" in item ? [[item.nodeId, item.status]] : [])),
          );

        const failedNodes = (runId: string) =>
          runs
            .events(runId)
            .filter((event) => event.kind === "failed")
            .map((event) => event.nodeId);

        type Loaded = { run: { doneCount: number }; snapshot: { nodes: Record<string, string> } };

        const loadedRun = async (runId: string) => (await answer("load-run", { runId })) as Loaded;

        const doneIn = (snapshot: Loaded["snapshot"]) =>
          Object.values(snapshot.nodes).filter((state) => state === "done").length;

        const listedDone = async (runId: string) =>
          ((await answer("list-runs", undefined)) as { id: string; doneCount: number }[]).find(
            (run) => run.id === runId,
          )?.doneCount;

        const startedSessionPushes = (runId: string) =>
          pushes.flatMap((push) => {
            const pushed = push as unknown as { push: string; runId?: string; sessions?: Pushed[] };
            return pushed.push === "run-sessions" && pushed.runId === runId
              ? [pushed.sessions]
              : [];
          });

        const androidContainer = async (buildId: string) => {
          const manifest = JSON.parse(
            await readFile(join(buildDirOf(buildId), "manifest.json"), "utf8"),
          ) as { containers: { name: string; prefix: string; nodes: ManifestNode[] }[] };
          const android = manifest.containers.find((container) => container.name === "android");
          if (android === undefined) throw new Error("no android container in the manifest");
          return android;
        };

        beforeEach(() => {
          alive = new Set();
          ended = [];
          runHandler();
        });

        it("offers Run for a two-session build", async () => {
          flows.save(workspaceFirst());
          const buildId = await builtId();

          expect(await answer("run-options", { buildId })).toEqual({
            kind: "choices",
            automatic: false,
          });
        });

        it("starts exactly one session, in the workspace folder on the workspace model, and none for the session containers", async () => {
          const { buildId, runId } = await startWorkspaceFirst();
          release();

          expect(await endOf(runId)).toBe("done");
          expect(claude.opened).toHaveLength(1);
          expect(claude.opened[0]).toMatchObject({
            cwd: workspaceFolder(buildDirOf(buildId)),
            model: "opus",
            workspaceFolder: workspaceFolder(buildDirOf(buildId)),
          });
          expect(runs.findRun(runId)?.session.cwd).toBe(workspaceFolder(buildDirOf(buildId)));
        });

        it("gives the workspace session each session container's tmux name and session id, recorded as that container's session under the workspace", async () => {
          const { buildId, runId, workspace, android, ios } = await startWorkspaceFirst();
          const [androidWorktree, iosWorktree] = containerWorktrees(buildId);

          expect(android.tmuxName).toMatch(/^fd-/);
          expect(ios.tmuxName).toMatch(/^fd-/);
          expect(new Set([workspace.sessionName, android.tmuxName, ios.tmuxName]).size).toBe(3);
          expect(android.claudeSessionId).not.toBe("");
          expect(ios.claudeSessionId).not.toBe("");
          expect(
            new Set([workspace.claudeSessionId, android.claudeSessionId, ios.claudeSessionId]).size,
          ).toBe(3);
          expect(runs.runSessions(runId)).toEqual([
            {
              tmuxName: workspace.sessionName,
              cwd: workspaceFolder(buildDirOf(buildId)),
              claudeSessionId: workspace.claudeSessionId,
              parent: null,
            },
            { ...android, cwd: androidWorktree, parent: workspace.claudeSessionId },
            { ...ios, cwd: iosWorktree, parent: workspace.claudeSessionId },
          ]);
          expect(runs.findRun(runId)?.nodeIds).toEqual(
            expect.arrayContaining([
              "workspace-1-start",
              "workspace-1-wait",
              "workspace-1-stop",
              "session-1-start",
              "session-1-plan",
              "session-1-stop",
              "session-2-start",
              "session-2-plan",
              "session-2-stop",
            ]),
          );
          expect(runs.nodeSessions(runId)).toEqual({
            "workspace-1-start": workspace.claudeSessionId,
            "workspace-1-wait": workspace.claudeSessionId,
            "workspace-1-stop": workspace.claudeSessionId,
            "session-1-start": android.claudeSessionId,
            "session-1-plan": android.claudeSessionId,
            "session-1-stop": android.claudeSessionId,
            "session-2-start": ios.claudeSessionId,
            "session-2-plan": ios.claudeSessionId,
            "session-2-stop": ios.claudeSessionId,
          });
        });

        it("ends done when the workspace reaches its Stop without starting a session, showing both containers not started", async () => {
          const { runId } = await startWorkspaceFirst();
          release();

          expect(await endOf(runId)).toBe("done");
          const groups = await groupsOf(runId);
          expect(groups.map((group) => group.name)).toEqual(["workspace", "android", "ios"]);
          expect(groupOf(groups, "workspace").status).toBe("done");
          expect(groupOf(groups, "android").status).toBe("not-started");
          expect(groupOf(groups, "ios").status).toBe("not-started");
          expect(failedNodes(runId)).toEqual([]);
          expect(sessionFailureOf(groups)).toBeUndefined();
        });

        it("puts the nodes of a session the workspace started under that container, done, with its usage in the run's cost", async () => {
          const usage = new FakeUsageSource();
          runHandler({}, { usage });
          const { buildId, runId, workspace, android } = await startWorkspaceFirst();
          const container = await androidContainer(buildId);
          const plan = container.nodes.find((node) => node.id === "session-1-plan");
          if (plan === undefined) throw new Error("no android plan node");
          const type = agentType(container.prefix, pieceOf(plan));
          const spend = (messageId: string, agent?: string): UsageEntry => ({
            messageId,
            model: "claude-haiku-5-5",
            inputTokens: 0,
            outputTokens: 1000,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            cacheReadTokens: 0,
            at: Date.now(),
            ...(agent === undefined ? {} : { agentType: agent }),
          });
          const workspaceSpend = spend("ws_main");
          const androidSpend = spend("android_plan", type);
          usage.setEntries(workspace.claudeSessionId, [workspaceSpend]);
          usage.setEntries(android.claudeSessionId, [androidSpend]);

          hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan", type));
          hook(android.claudeSessionId, "PostToolUse", agentDone("session-1-plan", type));
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("done"));
          const live = (await answer("run-cost", { runId })) as {
            nodes: { nodeId: string; cost: number }[];
            total: { cost: number };
          };
          hook(android.claudeSessionId, "Stop", { last_assistant_message: "DONE" });
          await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
          release();

          expect(live.nodes.find((line) => line.nodeId === "session-1-plan")?.cost).toBe(
            costOf([androidSpend]),
          );
          expect(live.total.cost).toBeCloseTo(costOf([workspaceSpend, androidSpend]), 12);
          expect(await endOf(runId)).toBe("done");
          const groups = await groupsOf(runId);
          expect(groupOf(groups, "android").status).toBe("done");
          expect(statusesOf(groupOf(groups, "android"))).toEqual({
            "session-1-start": "done",
            "session-1-plan": "done",
            "session-1-stop": "done",
          });
          expect(statusesOf(groupOf(groups, "workspace"))).not.toHaveProperty("session-1-plan");
          expect(groupOf(groups, "ios").status).toBe("not-started");
          const afterEnd = (await answer("run-cost", { runId })) as { total: { cost: number } };
          expect(afterEnd.total.cost).toBeCloseTo(costOf([workspaceSpend, androidSpend]), 12);
        });

        it("lists a started session's tool calls under its own node, not the workspace's waiting one", async () => {
          const { runId, android } = await startWorkspaceFirst();

          hook(android.claudeSessionId, "PreToolUse", {
            ...agentCall("session-1-plan"),
            flowdeck_hook_at: Date.now() - 5,
          });
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("running"));
          hook(android.claudeSessionId, "PreToolUse", {
            tool_name: "Bash",
            tool_input: { command: "ls" },
          });
          release();
          await endOf(runId);

          expect(
            runs
              .activity(runId)
              .filter(({ kind }) => kind === "subagent" || kind === "tool")
              .map(({ nodeId, kind }) => ({ nodeId, kind })),
          ).toEqual([
            { nodeId: "session-1-plan", kind: "subagent" },
            { nodeId: "session-1-plan", kind: "tool" },
          ]);
        });

        it("ends a session still running at the workspace's Stop and shows its node stopped, leaving the unstarted one alone", async () => {
          const { runId, android } = await startWorkspaceFirst();
          alive.add(android.tmuxName);
          hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("running"));

          release();

          expect(await endOf(runId)).toBe("done");
          expect(ended).toEqual([android.tmuxName]);
          const groups = await groupsOf(runId);
          expect(groupOf(groups, "android").status).toBe("stopped");
          expect(groupOf(groups, "ios").status).toBe("not-started");
          expect(failedNodes(runId)).toEqual([]);
        });

        it("ends the run failed, naming the container and node, when a started session fails though the workspace reaches its Stop", async () => {
          const { runId, android } = await startWorkspaceFirst();
          hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));
          hook(android.claudeSessionId, "StopFailure", { error: "rate_limit" });
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("failed"));

          release();

          expect(await endOf(runId)).toBe("failed");
          const groups = await groupsOf(runId);
          expect(groupOf(groups, "workspace").status).toBe("done");
          expect(groupOf(groups, "android").status).toBe("failed");
          expect(sessionFailureOf(groups)).toEqual({ container: "android", node: "Plan" });
        });

        it("ends the run failed, naming the container, when answering a started session's start dialogs fails", async () => {
          const answered: string[] = [];
          runHandler({
            answerDialogs: async (name: string) => {
              answered.push(name);
              throw new Error("the trust dialog never appeared");
            },
          } as Partial<EngineHandlerOptions>);
          const { runId, android, ios } = await startWorkspaceFirst();
          alive.add(android.tmuxName);
          await vi.waitFor(() => expect(answered).toEqual([android.tmuxName]), { timeout: 6000 });

          release();

          expect(await endOf(runId)).toBe("failed");
          expect(answered).not.toContain(ios.tmuxName);
          const groups = await groupsOf(runId);
          expect(groupOf(groups, "android").status).toBe("failed");
          expect(groupOf(groups, "ios").status).toBe("not-started");
          expect(sessionFailureOf(groups)).toMatchObject({ container: "android" });
        }, 10_000);

        it("shows a started session's permission request as needing the user on its running node, and goes on once answered", async () => {
          const permissions = new FakePermissionSource();
          const waits = createAppWaiter({ push: collectInto(pushes) });
          runHandler({ waits }, { permissions });
          const { runId, android } = await startWorkspaceFirst();
          hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("running"));

          const decision = permissions.ask(android.claudeSessionId, {
            hook_event_name: "PermissionRequest",
            session_id: android.claudeSessionId,
            tool_name: "Bash",
            tool_input: { command: "echo hi" },
          });

          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("needs-you"));
          const opened = pushes.findLast(
            (push): push is Extract<EnginePush, { push: "wait" }> =>
              push.push === "wait" && push.runId === runId && push.value !== null,
          )?.value;
          expect(opened?.request).toMatchObject({
            nodeId: "session-1-plan",
            kind: "permission",
            tool: "Bash",
          });
          expect(
            waits.answer({ waitId: opened?.waitId ?? "", reply: { decision: "approve" } }),
          ).toBe(true);
          expect(await decision).toEqual({ behavior: "allow" });
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("running"));
          release();
        });

        it("resumes the workspace and reopens each started session gone before its Stop with --resume, in its own tmux name and worktree", async () => {
          runHandler();
          const { buildId, runId, workspace, android, ios } = await startWorkspaceFirst();
          const [androidWorktree] = containerWorktrees(buildId);
          alive.add(android.tmuxName);
          hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));
          hook(android.claudeSessionId, "PostToolUse", agentDone("session-1-plan"));
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("done"));
          expect(await answer("stop-run", { runId })).toEqual({ stopped: true });
          expect(alive.has(android.tmuxName)).toBe(false);
          const openedBefore = claude.opened.length;

          expect(await answer("resume-run", { runId })).toMatchObject({ kind: "started" });

          await vi.waitFor(() => expect(claude.opened.length).toBe(openedBefore + 2));
          const reopened = claude.opened.slice(openedBefore);
          expect(reopened).toContainEqual(
            expect.objectContaining({
              sessionName: workspace.sessionName,
              claudeSessionId: workspace.claudeSessionId,
            }),
          );
          expect(reopened).toContainEqual(
            expect.objectContaining({
              sessionName: android.tmuxName,
              claudeSessionId: android.claudeSessionId,
              cwd: androidWorktree,
              resume: true,
            }),
          );
          expect(reopened.map((opening) => opening.sessionName)).not.toContain(ios.tmuxName);
          release();
        });

        describe("session states", () => {
          const statesPath = (runId: string) => join(home, "runs", runId, "session-states");

          const statesOf = (runId: string) => readFile(statesPath(runId), "utf8").catch(() => "");

          const lines = (...entries: [string, string][]) =>
            entries.map(([tmuxName, state]) => `${tmuxName} ${state}\n`).join("");

          it("writes both sessions not-started under the run's folder, then done for a session whose Stop is recorded, and gives the workspace that path", async () => {
            const { runId, workspace, android, ios } = await startWorkspaceFirst();

            await vi.waitFor(async () =>
              expect(await statesOf(runId)).toBe(
                lines([android.tmuxName, "not-started"], [ios.tmuxName, "not-started"]),
              ),
            );
            expect(workspace.sessionStatesPath).toBe(statesPath(runId));

            hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));
            hook(android.claudeSessionId, "PostToolUse", agentDone("session-1-plan"));
            hook(android.claudeSessionId, "Stop", { last_assistant_message: "DONE" });

            await vi.waitFor(async () =>
              expect(await statesOf(runId)).toBe(
                lines([android.tmuxName, "done"], [ios.tmuxName, "not-started"]),
              ),
            );
            release();
            await endOf(runId);
          });

          it("rewrites the file from the stored events when the run is resumed", async () => {
            const { runId, workspace, android, ios } = await startWorkspaceFirst();
            alive.add(android.tmuxName);
            hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));
            hook(android.claudeSessionId, "PostToolUse", agentDone("session-1-plan"));
            await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("done"));
            expect(await answer("stop-run", { runId })).toEqual({ stopped: true });
            await rm(statesPath(runId), { force: true });
            const publish = claude.events.publish.bind(claude.events);
            claude.events.publish = (event) => {
              if (event.kind !== "Stop" || event.sessionId !== android.claudeSessionId)
                publish(event);
            };
            const openedBefore = claude.opened.length;

            expect(await answer("resume-run", { runId })).toMatchObject({ kind: "started" });

            await vi.waitFor(async () =>
              expect(await statesOf(runId)).toBe(
                lines([android.tmuxName, "running"], [ios.tmuxName, "not-started"]),
              ),
            );
            expect(
              claude.opened
                .slice(openedBefore)
                .find((opening) => opening.sessionName === workspace.sessionName)
                ?.sessionStatesPath,
            ).toBe(statesPath(runId));
            release();
          });
        });

        describe("a started session found gone when Flowdeck picks the run up again", () => {
          const androidPlansAndBuilds = (): Flow => {
            const built = sessionsWorkflow(
              [
                {
                  name: "android",
                  repo: repo.path,
                  branch: "main",
                  model: "haiku",
                  members: ["Plan", "Build"],
                },
                { name: "ios", repo: repo.path, branch: "main", model: "sonnet" },
              ],
              { workspace: ["Wait"] },
            );
            return built;
          };

          const pickedUpAgain = async (
            beforeClosing: (androidId: string, runId: string) => Promise<void>,
            { refusal }: { refusal?: string } = {},
          ) => {
            const held = fakeClaudeSession(() => "hold");
            runHandler({
              run: {
                ...runEnvironment(new NodeFileSystem()),
                startEvents: async () => ({ events: held.events, stop: async () => undefined }),
                openSession: held.openSession,
              },
            });
            claude = held;
            flows.save(androidPlansAndBuilds());
            const buildId = await builtId();
            const runId = await startedOn(buildId);
            await vi.waitFor(() => expect(claude.sentTo("workspace-1-wait")).toHaveLength(1));
            const workspace = claude.opened[0];
            if (workspace === undefined) throw new Error("no workspace session opened");
            const env = (workspace as OpenSessionOptions & { env?: Record<string, string> }).env;
            const android = sessionOf(env ?? {}, "ANDROID");
            const container = await androidContainer(buildId);
            const named = (id: string) =>
              `NODE ${id} (${container.nodes.find((node) => node.id === id)?.label ?? ""})`;
            await beforeClosing(android.claudeSessionId, runId);
            await handler.detach();
            alive.add(workspace.sessionName);
            const prompts: { sessionName: string; text: string }[] = [];
            runHandler({
              run: {
                ...runEnvironment(new NodeFileSystem()),
                startEvents: async () => ({ events: claude.events, stop: async () => undefined }),
                openSession: async (options) => {
                  const opened = await claude.openSession(options);
                  if (options.sessionName !== android.tmuxName) return opened;
                  return {
                    ...opened,
                    prompts: {
                      ...opened.prompts,
                      sendPrompt: async (text) => {
                        if (refusal !== undefined) throw new Error(refusal);
                        prompts.push({ sessionName: options.sessionName, text });
                      },
                    },
                  };
                },
              },
            });
            await handler.reattach();
            const note = ((await answer("load-run", { runId })) as { note?: string }).note;
            return {
              runId,
              androidId: android.claudeSessionId,
              prefix: container.prefix,
              named,
              note,
              toAndroid: () =>
                prompts
                  .filter((prompt) => prompt.sessionName === android.tmuxName)
                  .map((prompt) => prompt.text),
              reopened: () =>
                claude.opened.filter((opening) => opening.sessionName === android.tmuxName),
            };
          };

          const finishes = (nodeId: string) => async (androidId: string, runId: string) => {
            hook(androidId, "PreToolUse", agentCall(nodeId));
            hook(androidId, "PostToolUse", agentDone(nodeId));
            await vi.waitFor(() => expect(statusOf(runId, nodeId)).toBe("done"));
          };

          it("reopens a session that died between nodes with one prompt to carry on from the first unfinished node, and finishes the run when its events arrive", async () => {
            const { runId, androidId, prefix, named, note, toAndroid, reopened } =
              await pickedUpAgain(finishes("session-1-plan"));
            const carryOn = `/${prefix}:run Already done: ${named("session-1-start")}, ${named("session-1-plan")}. Carry on from ${named("session-1-build")}; do not redo the done steps.`;

            expect(note).toBeUndefined();
            await vi.waitFor(() => expect(toAndroid()).toEqual([carryOn]));
            expect(reopened()).toEqual([expect.objectContaining({ resume: true })]);
            hook(androidId, "PreToolUse", agentCall("session-1-build"));
            hook(androidId, "PostToolUse", agentDone("session-1-build"));
            hook(androidId, "Stop", { last_assistant_message: "DONE" });
            await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
            release();

            expect(await endOf(runId)).toBe("done");
            expect(toAndroid()).toEqual([carryOn]);
            expect(failedNodes(runId)).toEqual([]);
          });

          it("fails a node cut off mid-step with the workspace's cut-off message, reopens nothing, and ends the run failed naming it", async () => {
            const { runId, note, toAndroid, reopened } = await pickedUpAgain(
              async (androidId, id) => {
                await finishes("session-1-plan")(androidId, id);
                hook(androidId, "PreToolUse", agentCall("session-1-build"));
                await vi.waitFor(() => expect(statusOf(id, "session-1-build")).toBe("running"));
              },
            );

            expect(note).toBeUndefined();
            await vi.waitFor(() => expect(statusOf(runId, "session-1-build")).toBe("failed"));
            expect(
              runs
                .events(runId)
                .findLast((event) => event.nodeId === "session-1-build" && event.kind === "failed"),
            ).toMatchObject({
              payload: {
                message:
                  "session-1-build failed: its Claude session ended before the turn finished; Retry sends it again",
              },
            });
            release();

            expect(await endOf(runId)).toBe("failed");
            expect(reopened()).toEqual([]);
            expect(toAndroid()).toEqual([]);
            expect(sessionFailureOf(await groupsOf(runId))).toEqual({
              container: "android",
              node: "Build",
            });
          });

          it("fails every node cut off mid-step in the gone session, not only the first", async () => {
            const { runId, reopened } = await pickedUpAgain(async (androidId, id) => {
              hook(androidId, "PreToolUse", agentCall("session-1-plan"));
              hook(androidId, "PreToolUse", agentCall("session-1-build"));
              await vi.waitFor(() => {
                expect(statusOf(id, "session-1-plan")).toBe("running");
                expect(statusOf(id, "session-1-build")).toBe("running");
              });
            });

            await vi.waitFor(() => {
              expect(statusOf(runId, "session-1-plan")).toBe("failed");
              expect(statusOf(runId, "session-1-build")).toBe("failed");
            });
            for (const nodeId of ["session-1-plan", "session-1-build"]) {
              expect(
                runs
                  .events(runId)
                  .findLast((event) => event.nodeId === nodeId && event.kind === "failed"),
              ).toMatchObject({
                payload: {
                  message: `${nodeId} failed: its Claude session ended before the turn finished; Retry sends it again`,
                },
              });
            }
            release();

            expect(await endOf(runId)).toBe("failed");
            expect(reopened()).toEqual([]);
          });

          it("fails the node it would carry on from with the error, and ends the run failed naming it, when the reopened session cannot be told to carry on", async () => {
            const { runId, toAndroid } = await pickedUpAgain(finishes("session-1-plan"), {
              refusal: "tmux: no server running",
            });

            await vi.waitFor(() => expect(statusOf(runId, "session-1-build")).toBe("failed"));
            expect(
              runs
                .events(runId)
                .findLast((event) => event.nodeId === "session-1-build" && event.kind === "failed"),
            ).toMatchObject({ payload: { message: "tmux: no server running" } });
            release();

            expect(await endOf(runId)).toBe("failed");
            expect(toAndroid()).toEqual([]);
            expect(sessionFailureOf(await groupsOf(runId))).toEqual({
              container: "android",
              node: "Build",
            });
          });

          it("reopens a session with only its Stop left and tells it to carry on from Stop", async () => {
            const { runId, androidId, prefix, named, note, toAndroid, reopened } =
              await pickedUpAgain(async (androidId, id) => {
                await finishes("session-1-plan")(androidId, id);
                await finishes("session-1-build")(androidId, id);
              });
            const carryOn = `/${prefix}:run Already done: ${named("session-1-start")}, ${named("session-1-plan")}, ${named("session-1-build")}. Carry on from ${named("session-1-stop")}; do not redo the done steps.`;

            expect(note).toBeUndefined();
            await vi.waitFor(() => expect(toAndroid()).toEqual([carryOn]));
            expect(reopened()).toEqual([expect.objectContaining({ resume: true })]);
            hook(androidId, "Stop", { last_assistant_message: "DONE" });
            await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
            release();

            expect(await endOf(runId)).toBe("done");
            expect(failedNodes(runId)).toEqual([]);
          });
        });

        describe("a session's Gate between two Agents, which has no events of its own", () => {
          const gated = "session-1-check";

          const planCheckBuild = (): Flow => {
            const built = sessionsWorkflow(
              [
                {
                  name: "android",
                  repo: repo.path,
                  branch: "main",
                  model: "haiku",
                  members: ["Plan", "Check", "Build"],
                },
                { name: "ios", repo: repo.path, branch: "main", model: "sonnet" },
              ],
              { workspace: ["Wait"] },
            );
            return {
              ...built,
              nodes: built.nodes.map((each) =>
                each.id === gated ? { ...gate(gated), label: "Check" } : each,
              ) as Flow["nodes"],
            };
          };

          const startGated = async () => {
            flows.save(planCheckBuild());
            const buildId = await builtId();
            const runId = await startedOn(buildId);
            await vi.waitFor(() => expect(claude.sentTo("workspace-1-wait")).toHaveLength(1));
            const env = (claude.opened[0] as OpenSessionOptions & { env?: Record<string, string> })
              .env;
            return { runId, android: sessionOf(env ?? {}, "ANDROID") };
          };

          const finishPlanAndBuild = async (androidId: string, runId: string) => {
            for (const nodeId of ["session-1-plan", "session-1-build"]) {
              hook(androidId, "PreToolUse", agentCall(nodeId));
              hook(androidId, "PostToolUse", agentDone(nodeId));
            }
            await vi.waitFor(() => expect(statusOf(runId, "session-1-build")).toBe("done"));
          };

          const runStates = (runId: string) =>
            pushes.flatMap((push) =>
              push.push === "run-state" && push.value.runId === runId ? [push.value] : [],
            );

          it("shows the finished session's Gate done live, on the loaded run page and in the narrator's digest", async () => {
            const narrator = new FakeRunNarrator({ text: "Told.", cost: 0.25 });
            runHandler({ narrator });
            const { runId, android } = await startGated();
            await finishPlanAndBuild(android.claudeSessionId, runId);
            hook(android.claudeSessionId, "Stop", { last_assistant_message: "DONE" });
            await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
            release();
            expect(await endOf(runId)).toBe("done");
            await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

            const loaded = (await answer("load-run", { runId })) as {
              snapshot: { nodes: Record<string, string> };
            };

            expect(statusOf(runId, gated)).toBe("waiting");
            expect(runStates(runId).at(-1)?.nodes[gated]).toBe("done");
            expect(loaded.snapshot.nodes[gated]).toBe("done");
            expect(
              narrator.calls[0]?.split("\n").find((line) => line.includes("Check (gate)")),
            ).toMatch(/: done$/);
          });

          it("gives the narrator the session's stages under Session android:", async () => {
            const narrator = new FakeRunNarrator({ text: "Told.", cost: 0.25 });
            runHandler({ narrator });
            const { runId, android } = await startGated();
            await finishPlanAndBuild(android.claudeSessionId, runId);
            hook(android.claudeSessionId, "Stop", { last_assistant_message: "DONE" });
            await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
            release();
            expect(await endOf(runId)).toBe("done");
            await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

            const digest = narrator.calls[0] ?? "";
            const lines = digest.split("\n");

            expect(digest).toContain("\nWorkspace:\n1. ");
            expect(digest).toContain("\nSession android:\n1. ");
            expect(lines.findIndex((line) => line.includes("Check (gate)"))).toBeGreaterThan(
              lines.indexOf("Session android:"),
            );
          });

          it("shows the Gate done in the snapshot it pushes when the run is resumed", async () => {
            const { runId, android } = await startGated();
            alive.add(android.tmuxName);
            await finishPlanAndBuild(android.claudeSessionId, runId);
            expect(await answer("stop-run", { runId })).toEqual({ stopped: true });
            const before = runStates(runId).length;

            expect(await answer("resume-run", { runId })).toMatchObject({ kind: "started" });

            expect(runStates(runId)[before]?.nodes[gated]).toBe("done");
            release();
          });

          it("lists the ended run, and loads its summary, with as many steps done as its page counts", async () => {
            runHandler();
            const { runId, android } = await startGated();
            await finishPlanAndBuild(android.claudeSessionId, runId);
            hook(android.claudeSessionId, "Stop", { last_assistant_message: "DONE" });
            await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
            release();
            expect(await endOf(runId)).toBe("done");

            const loaded = await loadedRun(runId);

            expect(loaded.snapshot.nodes[gated]).toBe("done");
            expect(await listedDone(runId)).toBe(doneIn(loaded.snapshot));
            expect(loaded.run.doneCount).toBe(doneIn(loaded.snapshot));
          });

          it("lists the resumed run with the steps it finished after the resume", async () => {
            const { runId, android } = await startGated();
            alive.add(android.tmuxName);
            await finishPlanAndBuild(android.claudeSessionId, runId);
            expect(await answer("stop-run", { runId })).toEqual({ stopped: true });
            const stopped = await listedDone(runId);
            expect(stopped).toBe(doneIn((await loadedRun(runId)).snapshot));

            expect(await answer("resume-run", { runId })).toMatchObject({ kind: "started" });
            hook(android.claudeSessionId, "Stop", { last_assistant_message: "DONE" });
            await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
            release();
            expect(await endOf(runId)).toBe("done");

            const finished = doneIn((await loadedRun(runId)).snapshot);
            expect(finished).toBeGreaterThan(stopped ?? 0);
            expect(await listedDone(runId)).toBe(finished);
          });
        });

        describe("a session's Fork and Join around two Agents, which have no events of their own", () => {
          const forked = (): Flow => {
            const built = sessionsWorkflow(
              [
                {
                  name: "android",
                  repo: repo.path,
                  branch: "main",
                  model: "haiku",
                  members: ["Fork", "Plan", "Build", "Join"],
                },
                { name: "ios", repo: repo.path, branch: "main", model: "sonnet" },
              ],
              { workspace: ["Wait"] },
            );
            const replaced: Record<string, Flow["nodes"][number]> = {
              "session-1-fork": {
                ...fork("session-1-fork"),
                label: "Fork",
              } as Flow["nodes"][number],
              "session-1-join": {
                ...joinNode("session-1-join"),
                label: "Join",
              } as Flow["nodes"][number],
            };
            const planToBuild = (each: Flow["wires"][number]) =>
              each.from.node === "session-1-plan" && each.to.node === "session-1-build";
            return {
              ...built,
              nodes: built.nodes.map((each) => replaced[each.id] ?? each),
              wires: [
                ...built.wires.filter((each) => !planToBuild(each)),
                thenWire("session-1-fork", "session-1-build"),
                thenWire("session-1-plan", "session-1-join"),
              ] as Flow["wires"],
            };
          };

          it("lists the ended run, and loads its summary, with as many steps done as its page counts", async () => {
            runHandler();
            flows.save(forked());
            const buildId = await builtId();
            const runId = await startedOn(buildId);
            await vi.waitFor(() => expect(claude.sentTo("workspace-1-wait")).toHaveLength(1));
            const env = (claude.opened[0] as OpenSessionOptions & { env?: Record<string, string> })
              .env;
            const android = sessionOf(env ?? {}, "ANDROID").claudeSessionId;
            hook(android, "PreToolUse", agentCall("session-1-plan"));
            hook(android, "PreToolUse", agentCall("session-1-build"));
            hook(android, "PostToolUse", agentDone("session-1-plan"));
            hook(android, "PostToolUse", agentDone("session-1-build"));
            await vi.waitFor(() => expect(statusOf(runId, "session-1-build")).toBe("done"));
            hook(android, "Stop", { last_assistant_message: "DONE" });
            await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
            release();
            expect(await endOf(runId)).toBe("done");

            const loaded = await loadedRun(runId);

            expect(statusOf(runId, "session-1-fork")).toBe("waiting");
            expect(statusOf(runId, "session-1-join")).toBe("waiting");
            expect(loaded.snapshot.nodes["session-1-fork"]).toBe("done");
            expect(loaded.snapshot.nodes["session-1-join"]).toBe("done");
            expect(await listedDone(runId)).toBe(doneIn(loaded.snapshot));
            expect(loaded.run.doneCount).toBe(doneIn(loaded.snapshot));
          });
        });

        it("reads each started session's worktree for the repo state, never the workspace folder, and lists no build folder as another repo", async () => {
          const gitState = gitAt(repo.path);
          runHandler({ gitState, userHome: "/u" });
          const phases = vi.spyOn(runs, "appendRepoState");
          const { buildId, runId, android } = await startWorkspaceFirst();
          const folder = workspaceFolder(buildDirOf(buildId));
          const [androidWorktree = "", iosWorktree = ""] = containerWorktrees(buildId);
          for (const path of [folder, androidWorktree, iosWorktree, "/x/web"]) {
            gitState.tops.set(path, path);
            gitState.repoStates.set(path, {
              kind: "read",
              branch: "main",
              head: "abc1234",
              upstream: { name: "origin/main", ahead: 0, behind: 0 },
              staged: 0,
              unstaged: 0,
              untracked: 0,
            });
          }
          hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));
          await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("running"));
          [folder, androidWorktree, iosWorktree, "/x/web"].forEach((path, index) =>
            runs.recordActivity(runId, {
              id: 900 + index,
              nodeId: "session-1-plan",
              at: 1,
              summary: "Edit",
              kind: "tool",
              tool: "Edit",
              input: JSON.stringify({ file_path: `${path}/a.ts` }),
            }),
          );
          hook(android.claudeSessionId, "PostToolUse", agentDone("session-1-plan"));
          hook(android.claudeSessionId, "Stop", { last_assistant_message: "DONE" });
          await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
          release();
          await endOf(runId);
          await vi.waitFor(() =>
            expect(phases.mock.calls.map(([, phase]) => phase)).toContain("after"),
          );

          expect(gitState.repoStateCalls).toContain(androidWorktree);
          expect(gitState.repoStateCalls).not.toContain(folder);
          const otherRepos = phases.mock.calls.at(-1)?.[3] ?? [];
          expect(otherRepos.map((other) => other.path)).toEqual(["/x/web"]);
        });

        it("pushes the started sessions for the terminal, the workspace first, adding a session once it starts", async () => {
          const { runId, workspace, android, ios } = await startWorkspaceFirst();
          await vi.waitFor(() =>
            expect(startedSessionPushes(runId).at(-1)).toEqual([
              { container: "workspace", tmuxName: workspace.sessionName },
            ]),
          );

          hook(android.claudeSessionId, "PreToolUse", agentCall("session-1-plan"));

          await vi.waitFor(() =>
            expect(startedSessionPushes(runId).at(-1)).toEqual([
              { container: "workspace", tmuxName: workspace.sessionName },
              { container: "android", tmuxName: android.tmuxName },
            ]),
          );
          expect(
            startedSessionPushes(runId)
              .flat()
              .map((pushed) => pushed?.tmuxName),
          ).not.toContain(ios.tmuxName);
          release();
        });
      });

      it("reports every worktree it had to keep when it deletes the build", async () => {
        const worktree = new FakeWorktree();
        handler = handlerWith({ worktree });
        flows.save(twoSessions());
        const buildId = await builtId();
        const worktrees = containerWorktrees(buildId);
        vi.spyOn(worktree, "remove").mockResolvedValue({ worktree: "kept", branch: "kept" });

        const result = await answer("delete-build", { buildId });

        const reported = JSON.stringify(deleteBuildResultSchema.parse(result));
        for (const path of worktrees) expect(reported).toContain(path);
      });

      describe("a pending build it left", () => {
        const dir = "/fd-home/workspaces/b-two";
        const left = [`${dir}/sessions/android/app`, `${dir}/sessions/ios/app`] as const;

        const endedRow = () => {
          const start = runs.startPendingBuild({
            flowId: "flow-1",
            version: 1,
            name: "two",
            origin: {
              source: { flowId: "flow-1", version: 1 },
              blueprint: { name: "Untitled", version: 1 },
            },
            startedAt: 1_000,
          });
          if (start.kind !== "started") throw new Error("the ended build did not start");
          for (const [container, path] of [
            ["android", left[0]],
            ["ios", left[1]],
          ] as const) {
            runs.addBuildWorktree("b-two", {
              container,
              repo: "/repos/app",
              base: "main",
              branch: `flowdeck/two-${container}`,
              branchCreated: true,
              path,
            });
          }
          runs.appendBuildEvent(start.pendingId, {
            type: "session",
            name: "fd-build-two",
            claudeSessionId: "claude-two",
            buildId: "b-two",
            repo: "",
            base: "",
            values: {},
          });
          runs.endPendingBuild(start.pendingId, { outcome: "failed", endedAt: 2_000 });
          return start.pendingId;
        };

        const leftOnDisk = () =>
          new FakeFileSystem(
            Object.fromEntries(left.map((path) => [`${path}/work.txt`, "kept\n"])),
          );

        it("previews the work any of its worktrees holds", async () => {
          handler = handlerWith({
            home: "/fd-home",
            fs: leftOnDisk(),
            worktree: new FakeWorktree({ dirty: [left[1] ?? ""] }),
          });
          const id = endedRow();

          expect(await answer("delete-pending-preview", { id })).toMatchObject({
            dirtyWorktree: true,
          });
        });

        it("removes every worktree its rows name, and its folder", async () => {
          const fs = leftOnDisk();
          const worktree = new FakeWorktree();
          handler = handlerWith({ home: "/fd-home", fs, worktree });
          const id = endedRow();

          await answer("delete-pending-build", { id });

          expect(worktree.removed).toEqual(
            left.map((path) => expect.objectContaining({ path, force: true })),
          );
          expect(await fs.exists(dir)).toBe(false);
          expect(runs.pendingBuild(id)).toBeNull();
        });
      });

      describe("read in the container layout", () => {
        const builtWithWork = async (blueprint: Flow) => {
          flows.save(blueprint);
          const buildId = await builtId();
          const dir = buildDirOf(buildId);
          const worktrees = runs.buildWorktrees(buildId).map((row) => row.path);
          for (const path of worktrees) await writeFile(join(path, "work.txt"), "kept\n");
          return { buildId, dir, worktrees };
        };

        const insideAny = (worktrees: string[], dir: string) => (path: string) =>
          worktrees.some((worktree) => join(dir, path).startsWith(`${worktree}/`));

        it("names the session container's worktree as the build's project", async () => {
          const { buildId } = await builtWithWork(twoAgents());

          expect(await answer("build-project", { buildId })).toMatchObject({
            path: worktreeOf(buildId),
            exists: true,
          });
        });

        it("lists the worktree's files by its path under the build", async () => {
          const { buildId, dir } = await builtWithWork(twoAgents());

          expect(
            await answer("build-entries", { buildId, path: relative(dir, worktreeOf(buildId)) }),
          ).toEqual([{ name: "work.txt", kind: "file" }]);
        });

        it("reads the build with its worktree, listing the build without walking into it", async () => {
          const { buildId, dir, worktrees } = await builtWithWork(twoAgents());

          const read = (await answer("assistant-read-build", { id: buildId })) as {
            workspace: { tree: string[] };
            worktree: unknown;
          };

          expect(worktrees).toEqual([worktreeOf(buildId)]);
          expect(read.worktree).toMatchObject({ path: worktreeOf(buildId), exists: true });
          expect(read.workspace.tree).toEqual(
            expect.arrayContaining(["workspace/CLAUDE.md", "sessions/main/CLAUDE.md"]),
          );
          expect(read.workspace.tree.filter(insideAny(worktrees, dir))).toEqual([]);
        });

        it("lists a pending build's whole folder without any of its worktrees", async () => {
          const { buildId, dir, worktrees } = await builtWithWork(twoSessions());

          const tree = (await answer("pending-build-tree", {
            pendingId: pendingIdOf(buildId),
          })) as {
            paths: string[];
          };

          expect(worktrees).toEqual(containerWorktrees(buildId));
          expect(tree.paths).toEqual(
            expect.arrayContaining([
              "workspace/CLAUDE.md",
              "sessions/android/CLAUDE.md",
              "sessions/ios/CLAUDE.md",
            ]),
          );
          expect(tree.paths.filter(insideAny(worktrees, dir))).toEqual([]);
        });
      });
    });

    describe("delete-run", () => {
      let db: ReturnType<typeof openDatabase>;
      let store: SqliteStore;
      let blueprints: SqliteFlowStore;
      let narrator: FakeRunNarrator;
      let ended: string[];

      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

      const deleteRun = async (runId: string) => {
        const response = await handler.handle({
          id: nextId++,
          type: "delete-run",
          payload: { runId },
        });
        expect(response).toMatchObject({ ok: true });
      };

      const listedIds = () => store.listRuns().map((run) => run.id);

      const runRows = (runId: string) => db.prepare("SELECT id FROM runs WHERE id = ?").all(runId);

      const statusesWhenRunMarked = () => {
        const seen: (string | undefined)[] = [];
        const mark = store.deleteRun.bind(store);
        vi.spyOn(store, "deleteRun").mockImplementation((id) => {
          seen.push(store.findRun(id)?.status);
          mark(id);
        });
        onTestFinished(() => {
          vi.restoreAllMocks();
        });
        return seen;
      };

      const interrupted = (buildId: string) => {
        const build = store.findBuild(buildId);
        if (build === undefined) throw new Error(`no build ${buildId}`);
        return store.createRun({
          buildDir: build.dir,
          inputs: {},
          nodeIds: ["start"],
          session: { tmuxName: "fd-run-left", cwd: repo.path, claudeSessionId: "c-left" },
          buildId,
        }).id;
      };

      beforeEach(() => {
        db = openDatabase({ path: join(home, "flowdeck.db") });
        store = new SqliteStore({ db });
        blueprints = new SqliteFlowStore({ db });
        narrator = new FakeRunNarrator({ text: "Told.", cost: 0.25 });
        ended = [];
        handler = handlerWith({
          openStores: () => ({ runs: store, flows: blueprints }),
          narrator,
          sessionAlive: async (name) => name === "fd-run-left",
          endSession: async (name) => {
            ended.push(name);
          },
        });
      });

      afterEach(async () => {
        await handler.stop();
        db.close();
      });

      it("hides an ended run from the list, leaves no row of it, and tells no further story", async () => {
        blueprints.save(twoAgents());
        const runId = await startedOn(await builtId());
        await untilFinished(runId);
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

        await deleteRun(runId);

        expect(listedIds()).not.toContain(runId);
        expect(runRows(runId)).toEqual([]);
        expect(store.findRun(runId)).toBeUndefined();
        await settle();
        expect(narrator.calls).toHaveLength(1);
      });

      it("stops a going run and waits for its end before hiding it, tells no story, and its build starts a new run", async () => {
        blueprints.save(sleeper());
        const buildId = await builtId();
        const runId = await startedOn(buildId);
        await vi.waitFor(() => {
          expect(snapshotsOf(runId).at(-1)?.nodes["nap"]).toBe("sent");
        });
        const markedWhile = statusesWhenRunMarked();

        await deleteRun(runId);

        expect(markedWhile).toEqual(["stopped"]);
        expect(listedIds()).not.toContain(runId);
        await settle();
        expect(narrator.calls).toEqual([]);
        expect(pushes).not.toContainEqual({ push: "story", runId });
        expect(await runBuild(buildId)).toMatchObject({ kind: "started" });
      });

      it("stops an interrupted run and ends its session before hiding it, tells no story, and its build starts a new run", async () => {
        blueprints.save(sleeper());
        const buildId = await builtId();
        const runId = interrupted(buildId);
        const markedWhile = statusesWhenRunMarked();

        await deleteRun(runId);

        expect(markedWhile).toEqual(["stopped"]);
        expect(ended).toEqual(["fd-run-left"]);
        expect(listedIds()).not.toContain(runId);
        await settle();
        expect(narrator.calls).toEqual([]);
        expect(pushes).not.toContainEqual({ push: "story", runId });
        expect(await runBuild(buildId)).toMatchObject({ kind: "started" });
      });

      it("removes the run's folder", async () => {
        blueprints.save(twoAgents());
        const runId = await startedOn(await builtId());
        await untilFinished(runId);
        const folder = join(home, "runs", runId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "session-states"), "fd-run-a done\n");

        await deleteRun(runId);

        await expect(stat(folder)).rejects.toThrow(/ENOENT/);
      });

      it("keeps a deleted run's folder gone when its last session-states write lands after the delete", async () => {
        const held = heldStatesWrites();
        handler = handlerWith({
          openStores: () => ({ runs: store, flows: blueprints }),
          fs: held.fs,
          run: runEnvironment(held.fs),
        });
        blueprints.save(sessionsWorkflow([{ name: "android", repo: repo.path, branch: "main" }]));
        try {
          const runId = await startedOn(await builtId());
          await untilFinished(runId);
          expect(held.pendingStatesWrites()).toBeGreaterThan(0);

          const deleting = deleteRun(runId);
          await macrotask();
          held.release();
          await deleting;
          await held.statesWritesLanded();

          await expect(stat(join(home, "runs", runId))).rejects.toThrow(/ENOENT/);
        } finally {
          held.release();
        }
      });

      it("deletes a run while another run's session-states write is still held", async () => {
        const held = heldStatesWrites();
        handler = handlerWith({
          openStores: () => ({ runs: store, flows: blueprints }),
          fs: held.fs,
          run: runEnvironment(held.fs),
        });
        blueprints.save(sessionsWorkflow([{ name: "android", repo: repo.path, branch: "main" }]));
        try {
          const kept = await startedOn(await builtId());
          await untilFinished(kept);
          expect(held.pendingStatesWrites()).toBeGreaterThan(0);
          held.holdNoMore();
          const deleted = await startedOn(await builtId());
          await untilFinished(deleted);

          let removed = false;
          const removing = deleteRun(deleted).then(() => {
            removed = true;
          });

          await vi.waitFor(() => expect(removed).toBe(true));
          expect(held.pendingStatesWrites()).toBeGreaterThan(0);
          await removing;
        } finally {
          held.release();
        }
      });

      it("does not pick a deleted run up again when the engine reattaches", async () => {
        blueprints.save(sleeper());
        const runId = interrupted(await builtId());
        store.deleteRun(runId);
        const eventsBefore = store.events(runId);

        await handler.reattach();
        await settle();

        expect(runRows(runId)).toEqual([]);
        expect(store.events(runId)).toEqual(eventsBefore);
        expect(sessionPushes(runId)).toEqual([]);
        expect(snapshotsOf(runId)).toEqual([]);
      });
    });

    describe("a deleted build", () => {
      let db: ReturnType<typeof openDatabase>;
      let store: SqliteStore;
      let blueprints: SqliteFlowStore;
      let waiter: FakeWaiter;

      beforeEach(() => {
        db = openDatabase({ path: join(home, "flowdeck.db") });
        store = new SqliteStore({ db });
        blueprints = new SqliteFlowStore({ db });
        waiter = new FakeWaiter([{ decision: "approve" }]);
        handler = handlerWith({
          openStores: () => ({ runs: store, flows: blueprints }),
          run: { ...runEnvironment(new NodeFileSystem()), waiter },
        });
      });

      afterEach(async () => {
        await handler.stop();
        db.close();
      });

      it("refuses to resume a stopped run of it once deleted, naming the build by its id", async () => {
        blueprints.save(sleeper());
        const buildId = await builtId();
        const build = store.findBuild(buildId);
        if (build === undefined) throw new Error(`no build ${buildId}`);
        const { id: runId } = store.createRun({
          buildDir: build.dir,
          inputs: {},
          nodeIds: ["nap"],
          session: { tmuxName: "fd-run-old", cwd: repo.path, claudeSessionId: "c-old" },
          buildId,
        });
        store.finishRun(runId, "stopped");
        store.deleteBuild(buildId);

        expect(
          await handler.handle({ id: 1, type: "resume-run", payload: { runId } }),
        ).toMatchObject({
          ok: true,
          value: { kind: "error", message: `No build ${buildId}` },
        });
        expect(store.findRun(runId)?.status).toBe("stopped");
        expect(waiter.calls).toEqual([]);
      });
    });
    describe("run story", () => {
      const narration = { text: "The run wrote and checked.\nNothing got in the way.", cost: 0.25 };
      let narrator: FakeRunNarrator;
      let logged: string[];
      let appends: MockInstance<FakeStore["appendRunStory"]>;
      let toldAtPush: (string | undefined)[];

      const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

      const settlesWhileHeld = (pending: Promise<unknown>) =>
        Promise.race([pending.then(() => "settled"), settle(2000).then(() => "still waiting")]);

      const appended = () => appends.mock.calls.map(([story]) => story);

      const storyNotWritten = (runId: string) =>
        logged.filter((line) => line.startsWith(`engine: run ${runId} story not written (`));

      const storyHandler = (turn: FakeTurnHandler = napsForever) =>
        handlerWith({
          narrator,
          publish: (push) => {
            pushes.push(push);
            if (push.push === "story") {
              toldAtPush.push(runs.latestRunStory(push.runId)?.runStatus);
            }
          },
          run: runEnvironment(new NodeFileSystem(), Date.now, turn),
        });

      const napSent = (runId: string) =>
        vi.waitFor(() => {
          expect(snapshotsOf(runId).at(-1)?.nodes["nap"]).toBe("sent");
        });

      const stopRunRequest = (runId: string) =>
        handler.handle({ id: nextId++, type: "stop-run", payload: { runId } });

      const loadedStory = async (runId: string) => {
        const loaded = await handler.handle({ id: nextId++, type: "load-run", payload: { runId } });
        return (loaded as { value: { story?: unknown } }).value.story;
      };

      const listedTotal = async (runId: string) => {
        const listed = await handler.handle({ id: nextId++, type: "list-runs" });
        return (listed as { value: { id: string; totalCost: unknown }[] }).value.find(
          (run) => run.id === runId,
        )?.totalCost;
      };

      const leftRunning = (buildId: string) =>
        runs.createRun({
          buildDir: buildDirOf(buildId),
          inputs: {},
          nodeIds: ["start"],
          session: { tmuxName: "fd-run-left", cwd: repo.path, claudeSessionId: "c-left" },
          buildId,
        }).id;

      const endRun = async (ending: "done" | "failed" | "stopped") => {
        if (ending === "stopped") {
          handler = storyHandler();
          flows.save(sleeper());
          const runId = await startedRunId();
          await napSent(runId);
          expect(narrator.calls).toEqual([]);
          await stopRunRequest(runId);
          return runId;
        }
        handler = storyHandler((nodeId, opening) =>
          ending === "failed" && nodeId === "check" ? "fail" : napsForever(nodeId, opening),
        );
        flows.save(twoAgents());
        const runId = await startedRunId();
        await untilFinished(runId);
        return runId;
      };

      const buildOf = (runId: string) => {
        const buildId = runs.findRun(runId)?.buildId;
        if (buildId === undefined) throw new Error(`no build for run ${runId}`);
        return buildId;
      };

      const headerAndDigest = (runId: string) => ({
        header: expect.objectContaining({ name: runs.findBuild(buildOf(runId))?.name }),
        digest: expect.stringMatching(/\S/),
      });

      beforeEach(() => {
        narrator = new FakeRunNarrator(narration);
        logged = [];
        toldAtPush = [];
        appends = vi.spyOn(runs, "appendRunStory");
        vi.spyOn(console, "log").mockImplementation((line: unknown) => {
          logged.push(String(line));
        });
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each(["done", "failed", "stopped"] as const)(
        "tells a %s run's story once from the digest the page shows, and announces it after storing it",
        async (ending) => {
          const runId = await endRun(ending);

          await vi.waitFor(() => expect(appended()).toHaveLength(1));
          await settle();
          expect(runs.findRun(runId)?.status).toBe(ending);
          expect(appended()).toEqual([
            {
              runId,
              at: expect.any(String),
              runStatus: ending,
              text: narration.text,
              cost: narration.cost,
            },
          ]);
          const shown = (await loadedStory(runId)) as { digest?: string } | undefined;
          expect(narrator.calls).toEqual([shown?.digest]);
          expect(pushes.filter((push) => push.push === "story")).toEqual([
            { push: "story", runId },
          ]);
          expect(toldAtPush).toEqual([ending]);
          expect(await loadedStory(runId)).toEqual({
            ...headerAndDigest(runId),
            written: {
              text: narration.text,
              at: expect.any(String),
              runStatus: ending,
              cost: narration.cost,
            },
          });
        },
      );

      it("keeps the narrator's cost on the story alone, out of the run's total", async () => {
        const release = narrator.hold();
        const runId = await endRun("done");
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));
        const costBefore = runs.costOf(runId);
        const listedBefore = await listedTotal(runId);

        release();
        await vi.waitFor(() => expect(appended()).toHaveLength(1));

        expect(appended()[0]?.cost).toBe(narration.cost);
        expect(runs.costOf(runId)).toEqual(costBefore);
        expect(await listedTotal(runId)).toEqual(listedBefore);
      });

      it("tells the story of an interrupted run stopped while no run of it is going", async () => {
        handler = storyHandler();
        flows.save(sleeper());
        const runId = leftRunning(await builtId());

        expect(await stopRunRequest(runId)).toMatchObject({ ok: true, value: { stopped: true } });

        await vi.waitFor(() => expect(appended()).toHaveLength(1));
        expect(appended()[0]).toMatchObject({ runId, runStatus: "stopped", text: narration.text });
        expect(pushes).toContainEqual({ push: "story", runId });
      });

      it("writes no story when the narrator fails, logs why, and the run still ends and its page has the header and digest", async () => {
        narrator.failWith(new Error("narrator down"));
        const runId = await endRun("failed");

        await vi.waitFor(() => expect(storyNotWritten(runId)).toHaveLength(1));
        expect(storyNotWritten(runId)[0]).toMatch(/\(.*narrator down.*\)$/);
        expect(narrator.calls).toHaveLength(1);
        expect(appended()).toEqual([]);
        expect(pushes).not.toContainEqual({ push: "story", runId });
        expect(runs.findRun(runId)?.status).toBe("failed");
        expect(await loadedStory(runId)).toEqual({ ...headerAndDigest(runId), written: null });
        await expect(startedOn(buildOf(runId))).resolves.toEqual(expect.any(String));
      });

      it("lets Stop, the build's next run and closing go ahead while a story is still being written", async () => {
        narrator.hold();
        handler = storyHandler();
        flows.save(sleeper());
        const buildId = await builtId();
        const first = await startedOn(buildId);
        await napSent(first);

        expect(await settlesWhileHeld(stopRunRequest(first))).toBe("settled");
        expect(runs.findRun(first)?.status).toBe("stopped");
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

        const second = await startedOn(buildId);
        await napSent(second);
        expect(await settlesWhileHeld(handler.stop())).toBe("settled");
        expect(runs.findRun(second)?.status).toBe("stopped");
        expect(appended()).toEqual([]);
      });

      it("drops the story of a stopped ending that a resume overtook, and tells the resumed run's own ending", async () => {
        const release = narrator.hold();
        let naps = 0;
        handler = storyHandler((nodeId) => (nodeId === "nap" && ++naps === 1 ? "hold" : "done"));
        flows.save(sleeper());
        const runId = await startedRunId();
        await napSent(runId);
        await stopRunRequest(runId);
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

        expect(
          await handler.handle({ id: nextId++, type: "resume-run", payload: { runId } }),
        ).toMatchObject({ ok: true, value: { kind: "started", runId } });
        await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"));
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(2));
        release();

        await vi.waitFor(() => expect(storyNotWritten(runId)).toHaveLength(1));
        await vi.waitFor(() => expect(appended()).toHaveLength(1));
        await settle();
        expect(appended()).toEqual([expect.objectContaining({ runId, runStatus: "done" })]);
        expect(await loadedStory(runId)).toMatchObject({
          written: { runStatus: "done", text: narration.text },
        });
      });

      it("aborts a story still being written when Flowdeck detaches, and starts none after", async () => {
        const release = narrator.hold();
        const runId = await endRun("done");
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

        await handler.detach();

        await vi.waitFor(() => expect(storyNotWritten(runId)).toHaveLength(1));
        release();
        const left = leftRunning(buildOf(runId));
        expect(await stopRunRequest(left)).toMatchObject({ ok: true, value: { stopped: true } });
        await settle();
        expect(narrator.calls).toHaveLength(1);
        expect(appended()).toEqual([]);
      });

      it("aborts a story still being written when the engine stops, and tells none for the runs it stops", async () => {
        const release = narrator.hold();
        const finished = await endRun("done");
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));
        flows.save(sleeper());
        const napping = await startedOn(await builtId());
        await napSent(napping);

        await handler.stop();

        await vi.waitFor(() => expect(storyNotWritten(finished)).toHaveLength(1));
        release();
        await settle();
        expect(runs.findRun(napping)?.status).toBe("stopped");
        expect(narrator.calls).toHaveLength(1);
        expect(appended()).toEqual([]);
      });

      it("tells no story without a narrator, logging nothing about one, and the page still has the header and digest", async () => {
        handler = handlerWith({
          run: runEnvironment(new NodeFileSystem(), Date.now, () => "done"),
        });
        flows.save(twoAgents());
        const runId = await startedRunId();
        await untilFinished(runId);
        await settle();

        expect(appended()).toEqual([]);
        expect(logged.filter((line) => line.includes("story"))).toEqual([]);
        expect(await loadedStory(runId)).toEqual({ ...headerAndDigest(runId), written: null });
      });

      describe("write-story", () => {
        const writeStory = async (runId: string) => {
          const response = await handler.handle({
            id: nextId++,
            type: "write-story",
            payload: { runId },
          });
          expect(response).toMatchObject({ ok: true });
          return (response as { value: unknown }).value;
        };

        const refused = { ok: false, error: expect.stringMatching(/\S/) };

        const endedWithoutStory = async () => {
          handler = storyHandler();
          flows.save(sleeper());
          const runId = leftRunning(await builtId());
          runs.finishRun(runId, "stopped");
          return runId;
        };

        it("writes one story for an ended run that has none, announces it, and answers ok", async () => {
          const runId = await endedWithoutStory();

          expect(await writeStory(runId)).toEqual({ ok: true });

          const shown = (await loadedStory(runId)) as { digest?: string } | undefined;
          expect(narrator.calls).toEqual([shown?.digest]);
          expect(appended()).toEqual([
            {
              runId,
              at: expect.any(String),
              runStatus: "stopped",
              text: narration.text,
              cost: narration.cost,
            },
          ]);
          expect(pushes.filter((push) => push.push === "story")).toEqual([
            { push: "story", runId },
          ]);
        });

        it("refuses a second request while the first is still writing, and writes one story", async () => {
          const release = narrator.hold();
          const runId = await endedWithoutStory();

          const first = writeStory(runId);
          await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));
          expect(await writeStory(runId)).toEqual(refused);
          release();

          expect(await first).toEqual({ ok: true });
          await settle();
          expect(narrator.calls).toHaveLength(1);
          expect(appended()).toHaveLength(1);
        });

        it("refuses while the run's own end-of-run story is still being written, and writes one story", async () => {
          const release = narrator.hold();
          const runId = await endRun("done");
          await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

          expect(await writeStory(runId)).toEqual(refused);
          release();

          await vi.waitFor(() => expect(appended()).toHaveLength(1));
          await settle();
          expect(narrator.calls).toHaveLength(1);
          expect(appended()).toHaveLength(1);
        });

        it("refuses a run that already has a story, writing none", async () => {
          const runId = await endRun("done");
          await vi.waitFor(() => expect(appended()).toHaveLength(1));

          expect(await writeStory(runId)).toEqual(refused);

          await settle();
          expect(narrator.calls).toHaveLength(1);
          expect(appended()).toHaveLength(1);
        });

        it("refuses a run that is still running, writing none", async () => {
          handler = storyHandler();
          flows.save(sleeper());
          const runId = leftRunning(await builtId());

          expect(await writeStory(runId)).toEqual(refused);

          await settle();
          expect(narrator.calls).toEqual([]);
          expect(appended()).toEqual([]);
          expect(runs.findRun(runId)?.status).toBe("running");
        });

        it("answers the narrator's error, writing no story", async () => {
          const runId = await endedWithoutStory();
          narrator.failWith(new Error("narrator down"));

          expect(await writeStory(runId)).toEqual({
            ok: false,
            error: expect.stringContaining("narrator down"),
          });

          expect(narrator.calls).toHaveLength(1);
          expect(appended()).toEqual([]);
          expect(pushes).not.toContainEqual({ push: "story", runId });
        });
      });

      describe("repo states", () => {
        let gitState: FakeGitState;
        let phases: MockInstance<FakeStore["appendRepoState"]>;

        const readState = (head: string, behind = 0, branch: string | null = "flowdeck/x") => ({
          kind: "read" as const,
          branch,
          head,
          upstream: { name: "origin/main", ahead: 0, behind },
          staged: 0,
          unstaged: 0,
          untracked: 0,
        });

        const recordedPhases = () => phases.mock.calls.map(([, phase]) => phase);

        const repoHandler = (
          turn: FakeTurnHandler = napsForever,
          overrides: Partial<EngineHandlerOptions> = {},
        ) =>
          handlerWith({
            narrator,
            gitState,
            run: runEnvironment(new NodeFileSystem(), Date.now, turn),
            ...overrides,
          });

        const latestRunId = () => {
          const id = runs.runs.at(-1)?.id;
          if (id === undefined) throw new Error("no run yet");
          return id;
        };

        const toolStep = (id: number, tool: string, input: object) => ({
          id,
          nodeId: "write",
          at: 1,
          summary: tool,
          kind: "tool" as const,
          tool,
          input: JSON.stringify(input),
        });

        beforeEach(() => {
          gitState = gitAt(repo.path);
          phases = vi.spyOn(runs, "appendRepoState");
        });

        it.each(["done", "failed"] as const)(
          "records the worktree before the first step and after a %s ending, before the story is told",
          async (ending) => {
            let beforeAtFirstStep: unknown;
            let worktree = "";
            handler = repoHandler((nodeId) => {
              if (nodeId === "write") {
                beforeAtFirstStep = runs.repoStates(latestRunId()).before;
                gitState.repoStates.set(worktree, readState("def5678"));
              }
              return ending === "failed" && nodeId === "check" ? "fail" : "done";
            });
            flows.save(twoAgents());
            const buildId = await builtId();
            worktree = worktreeOf(buildId);
            gitState.repoStates.set(worktree, readState("abc1234", 1));
            const runId = await startedOn(buildId);
            await untilFinished(runId);
            await vi.waitFor(() => expect(appended()).toHaveLength(1));

            expect(runs.findRun(runId)?.status).toBe(ending);
            expect(gitState.repoStateCalls[0]).toBe(worktree);
            expect(runs.findRun(runId)?.session.cwd).toBe(workspaceFolder(buildDirOf(buildId)));
            expect(beforeAtFirstStep).toEqual(readState("abc1234", 1));
            expect(recordedPhases()).toEqual(["before", "after"]);
            expect(narrator.calls[0]).toContain(
              "Before: on flowdeck/x at abc1234, 1 behind and 0 ahead of origin/main as of the last fetch",
            );
            expect(narrator.calls[0]).toContain("After: on flowdeck/x at def5678");
          },
        );

        it("answers Run before the worktree is read, and starts no turn until the read lands", async () => {
          const turns: string[] = [];
          handler = repoHandler((nodeId) => {
            turns.push(nodeId);
            return "done";
          });
          flows.save(twoAgents());
          const buildId = await builtId();
          let release: (state: RepoState) => void = () => undefined;
          vi.spyOn(gitState, "repoState").mockImplementationOnce(
            () => new Promise<RepoState>((resolve) => (release = resolve)),
          );

          const runId = await startedOn(buildId);
          await settle();

          expect(turns).toEqual([]);
          expect(runs.repoStates(runId).before).toBeNull();

          release(readState("abc1234"));
          await untilFinished(runId);

          expect(turns.length).toBeGreaterThan(0);
          expect(runs.repoStates(runId).before).toEqual(readState("abc1234"));
        });

        it("records the after state of a run stopped while no run of it is going, then tells its story", async () => {
          handler = repoHandler();
          flows.save(sleeper());
          const buildId = await builtId();
          const runId = leftRunning(buildId);
          gitState.repoStates.set(worktreeOf(buildId), readState("fee1234"));

          expect(await stopRunRequest(runId)).toMatchObject({ ok: true, value: { stopped: true } });

          await vi.waitFor(() => expect(appended()).toHaveLength(1));
          expect(recordedPhases()).toEqual(["after"]);
          expect(narrator.calls[0]).toContain("Before: not recorded");
          expect(narrator.calls[0]).toContain("After: on flowdeck/x at fee1234");
        });

        it("keeps the first before and the latest after across a resume", async () => {
          let naps = 0;
          handler = repoHandler((nodeId) => (nodeId === "nap" && ++naps === 1 ? "hold" : "done"));
          flows.save(sleeper());
          const buildId = await builtId();
          const worktree = worktreeOf(buildId);
          gitState.repoStates.set(worktree, readState("aaa1111"));
          const runId = await startedOn(buildId);
          await napSent(runId);
          gitState.repoStates.set(worktree, readState("bbb2222"));
          await stopRunRequest(runId);
          await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));
          gitState.repoStates.set(worktree, readState("ccc3333"));

          expect(
            await handler.handle({ id: nextId++, type: "resume-run", payload: { runId } }),
          ).toMatchObject({ ok: true, value: { kind: "started", runId } });
          await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"));
          await vi.waitFor(() => expect(narrator.calls).toHaveLength(2));

          expect(recordedPhases()).toEqual(["before", "after", "after"]);
          expect(narrator.calls[0]).toContain("After: on flowdeck/x at bbb2222");
          expect(narrator.calls[1]).toContain("Before: on flowdeck/x at aaa1111");
          expect(narrator.calls[1]).toContain("After: on flowdeck/x at ccc3333");
        });

        it("ends the run normally and says not recorded when the worktree cannot be read", async () => {
          vi.spyOn(gitState, "repoState").mockRejectedValue(new Error("git is gone"));
          handler = repoHandler(() => "done");
          flows.save(twoAgents());
          const runId = await startedRunId();
          await untilFinished(runId);
          await vi.waitFor(() => expect(appended()).toHaveLength(1));

          expect(runs.findRun(runId)?.status).toBe("done");
          expect(recordedPhases()).toEqual(["before", "after"]);
          expect(narrator.calls[0]).toContain("Before: not recorded");
          expect(narrator.calls[0]).toContain("After: not recorded");
        });

        it("adds no run events, so the story is kept", async () => {
          let eventsAtAfter: number | undefined;
          phases.mockImplementation((runId, phase, state, otherRepos) => {
            if (phase === "after") eventsAtAfter = runs.events(runId).length;
            FakeStore.prototype.appendRepoState.call(runs, runId, phase, state, otherRepos);
          });
          handler = repoHandler(() => "done");
          flows.save(twoAgents());
          const runId = await startedRunId();
          await untilFinished(runId);
          await vi.waitFor(() => expect(appended()).toHaveLength(1));

          expect(eventsAtAfter).toBe(runs.events(runId).length);
          expect(appended()[0]).toMatchObject({ runId, runStatus: "done" });
        });

        it("lists the other repos the run's steps touched, with their branches, sorted", async () => {
          handler = repoHandler(
            (nodeId, opening) => {
              if (nodeId === "write") {
                for (const step of [
                  toolStep(901, "Bash", { command: "cd ~/web && git pull" }),
                  toolStep(902, "Write", { file_path: "/x/ios/a.ts", content: "x" }),
                  toolStep(903, "Edit", { file_path: `${opening.cwd}/src/a.ts` }),
                  toolStep(904, "Read", { file_path: `${repo.path}/b.ts` }),
                  toolStep(905, "Read", { file_path: "/nowhere/c.ts" }),
                  toolStep(906, "Bash", { command: "git -C /x/det status" }),
                ]) {
                  runs.recordActivity(latestRunId(), step);
                }
                gitState.tops.set(opening.cwd, opening.cwd);
                gitState.repoStates.set(opening.cwd, readState("4444444"));
              }
              return "done";
            },
            { userHome: "/u" },
          );
          gitState.tops.set("/u/web", "/u/web");
          gitState.tops.set("/x/ios", "/x/ios");
          gitState.tops.set("/x/det", "/x/det");
          gitState.tops.set(repo.path, repo.path);
          gitState.repoStates.set(repo.path, readState("5555555", 0, "main"));
          gitState.repoStates.set("/u/web", readState("1111111", 0, "master"));
          gitState.repoStates.set("/x/ios", readState("2222222", 0, "develop"));
          gitState.repoStates.set("/x/det", readState("3333333", 0, null));
          flows.save(twoAgents());
          const runId = await startedRunId();
          await untilFinished(runId);
          await vi.waitFor(() => expect(appended()).toHaveLength(1));

          const otherRepos = [
            { path: "/u/web", branch: "master", after: readState("1111111", 0, "master") },
            { path: "/x/det", branch: "detached 3333333", after: readState("3333333", 0, null) },
            { path: "/x/ios", branch: "develop", after: readState("2222222", 0, "develop") },
          ];
          expect(phases.mock.calls.at(-1)?.[3]).toEqual(otherRepos);
          expect(narrator.calls[0]).toContain(
            "Other repos: /u/web (master): before not recorded; after on master at 1111111,",
          );
          expect(narrator.calls[0]).toContain(
            "/x/det (detached 3333333): before not recorded; after detached at 3333333,",
          );
          expect(narrator.calls[0]).toContain(
            "/x/ios (develop): before not recorded; after on develop at 2222222,",
          );
          expect(await loadedStory(runId)).toMatchObject({ header: { otherRepos } });
        });

        it("loads a run whose other repos were stored with their branches only", async () => {
          handler = repoHandler();
          flows.save(sleeper());
          const runId = leftRunning(await builtId());
          runs.finishRun(runId, "stopped");
          runs.appendRepoState(runId, "after", { kind: "unreadable" }, [
            { path: "/x/old", branch: "main" },
          ]);

          const story = (await loadedStory(runId)) as { header: object; digest: string };

          expect(story.header).toMatchObject({ otherRepos: [{ path: "/x/old", branch: "main" }] });
          expect(story.digest).toMatch(/^Other repos: \/x\/old \(main\)$/m);
        });

        describe("another repo an agent touches", () => {
          let toolStarts: FakeToolStartSource;

          const gatedHandler = (turn: FakeTurnHandler) => {
            const environment = runEnvironment(new NodeFileSystem(), Date.now, turn);
            return repoHandler(turn, {
              userHome: "/u",
              run: {
                ...environment,
                startEvents: async () => ({ ...(await environment.startEvents()), toolStarts }),
              },
            });
          };

          const touchB = (opening: OpenSessionOptions, file = "/x/b/src/a.ts") =>
            toolStarts.start(opening.claudeSessionId, {
              tool_name: "Edit",
              tool_input: { file_path: file, old_string: "a", new_string: "b" },
            });

          beforeEach(() => {
            toolStarts = new FakeToolStartSource();
            gitState.tops.set("/x/b", "/x/b");
            gitState.repoStates.set("/x/b", readState("1111111", 0, "main"));
          });

          it("records its before on the first touch and its after at the run's end", async () => {
            handler = gatedHandler(async (nodeId, opening) => {
              if (nodeId === "write") {
                await touchB(opening);
                runs.recordActivity(
                  latestRunId(),
                  toolStep(901, "Edit", { file_path: "/x/b/src/a.ts" }),
                );
                gitState.repoStates.set("/x/b", readState("2222222", 0, "main"));
              }
              return "done" as const;
            });
            flows.save(twoAgents());
            const runId = await startedRunId();
            await untilFinished(runId);
            await vi.waitFor(() => expect(appended()).toHaveLength(1));

            const otherRepos = [
              {
                path: "/x/b",
                branch: "main",
                before: readState("1111111", 0, "main"),
                after: readState("2222222", 0, "main"),
              },
            ];
            expect(runs.repoStates(runId).otherRepos).toEqual(otherRepos);
            expect(narrator.calls[0]).toContain(
              "Other repos: /x/b (main): before on main at 1111111,",
            );
            expect(narrator.calls[0]).toContain("; after on main at 2222222,");
            expect(await loadedStory(runId)).toMatchObject({ header: { otherRepos } });
          });

          it("reads the after of a repo with a before that no step's preview names", async () => {
            handler = gatedHandler(async (nodeId, opening) => {
              if (nodeId === "write") {
                await touchB(opening);
                gitState.repoStates.set("/x/b", readState("2222222", 0, "main"));
              }
              return "done" as const;
            });
            flows.save(twoAgents());
            const runId = await startedRunId();
            await untilFinished(runId);
            await vi.waitFor(() => expect(appended()).toHaveLength(1));

            expect(runs.repoStates(runId).otherRepos).toEqual([
              {
                path: "/x/b",
                branch: "main",
                before: readState("1111111", 0, "main"),
                after: readState("2222222", 0, "main"),
              },
            ]);
          });

          it("does not record the before again when a resumed run touches the repo", async () => {
            let naps = 0;
            const befores = vi.spyOn(runs, "appendOtherRepoBefore");
            handler = gatedHandler(async (nodeId, opening) => {
              if (nodeId !== "nap") return "done";
              await touchB(opening, `/x/b/nap-${++naps}.ts`);
              return naps === 1 ? "hold" : "done";
            });
            flows.save(sleeper());
            const runId = await startedOn(await builtId());
            await napSent(runId);
            await stopRunRequest(runId);
            await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));
            gitState.repoStates.set("/x/b", readState("3333333", 0, "main"));

            expect(
              await handler.handle({ id: nextId++, type: "resume-run", payload: { runId } }),
            ).toMatchObject({ ok: true, value: { kind: "started", runId } });
            await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"));
            await vi.waitFor(() => expect(narrator.calls).toHaveLength(2));

            expect(naps).toBe(2);
            expect(befores.mock.calls).toEqual([[runId, "/x/b", readState("1111111", 0, "main")]]);
            expect(runs.repoStates(runId).otherRepos).toMatchObject([
              { path: "/x/b", before: readState("1111111", 0, "main") },
            ]);
          });
        });

        it("loads a run from before repo states were kept with no other repos and not recorded", async () => {
          handler = repoHandler();
          flows.save(sleeper());
          const runId = leftRunning(await builtId());
          runs.finishRun(runId, "stopped");

          const story = (await loadedStory(runId)) as { header: object; digest: string };

          expect(story.header).not.toHaveProperty("otherRepos");
          expect(story.digest).toContain("Before: not recorded");
          expect(story.digest).toContain("After: not recorded");
        });

        it("records no after state when Flowdeck detaches from a running run", async () => {
          handler = repoHandler();
          flows.save(sleeper());
          const runId = await startedRunId();
          await napSent(runId);

          await handler.detach();
          await settle();

          expect(recordedPhases()).toEqual(["before"]);
        });
      });
    });

    it("returns the open error when the stores fail to open", async () => {
      handler = handlerWith({ openStores: failingOpen });

      expect(await runBuild("any")).toEqual({ kind: "error", message: "boom" });
    });

    it("stops an active run, resolving once it is recorded stopped", async () => {
      flows.save(sleeper());
      const runId = await startedRunId();
      await vi.waitFor(() => {
        expect(snapshotsOf(runId).at(-1)?.nodes["nap"]).toBe("sent");
      });

      await handler.stop();

      expect(runs.findRun(runId)?.status).toBe("stopped");
      expect(snapshotsOf(runId).at(-1)?.status).toBe("stopped");
    });

    it("resolves stop at once when no run is active", async () => {
      await expect(handler.stop()).resolves.toBeUndefined();
      expect(pushes).toEqual([]);
    });

    const withStartEvents = (startEvents: EngineHandlerOptions["run"]["startEvents"]) =>
      handlerWith({ run: { ...runEnvironment(new NodeFileSystem()), startEvents } });

    const failingStartEvents = async (): Promise<never> => {
      throw new Error("socket in use");
    };

    it("stops a run whose start is still in progress once it has started", async () => {
      flows.save(sleeper());
      const buildId = await builtId();

      const starting = handler.handle({ id: 1, type: "run-build", payload: { buildId } });
      await handler.stop();
      const { value } = (await starting) as { value: { kind: string; runId: string } };

      expect(value.kind).toBe("started");
      expect(runs.findRun(value.runId)?.status).toBe("stopped");
    });

    it("remembers a stop that arrives before the run listens for it, and stops the run", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      handler = withStartEvents(async () => {
        await gate;
        return { events: new FakeEventSource(), stop: async () => undefined };
      });
      flows.save(sleeper());
      const runId = await startedRunId();

      const stopped = handler.stop();
      release();
      await stopped;

      expect(runs.findRun(runId)?.status).toBe("stopped");
      expect(snapshotsOf(runId).at(-1)?.status).toBe("stopped");
    });

    it("records the run failed when execution rejects, and accepts a later run of its build", async () => {
      handler = withStartEvents(failingStartEvents);
      flows.save(twoAgents());
      const buildId = await builtId();
      const runId = await startedOn(buildId);

      await vi.waitFor(() => {
        expect(runs.findRun(runId)?.status).toBe("failed");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(snapshotsOf(runId).at(-1)?.status).toBe("failed");
      expect((await runBuild(buildId)).kind).toBe("started");
    });

    it("frees the build's run slot and resolves stop when recording a failed run throws", async () => {
      handler = withStartEvents(failingStartEvents);
      runs.finishRun = () => {
        throw new Error("database is locked");
      };
      flows.save(twoAgents());
      const buildId = await builtId();
      const first = await startedOn(buildId);
      runs.stopRun(first);

      await vi.waitFor(async () => {
        expect((await runBuild(buildId)).kind).toBe("started");
      });

      await expect(handler.stop()).resolves.toBeUndefined();
    });

    const promptFlow = () =>
      atRepo(
        workspaceFlow(
          [trigger("start"), agent("plan"), output("stop")],
          [thenWire("start", "plan"), thenWire("plan", "stop")],
        ),
      );

    const claudeSession = (ensureStarted: () => Promise<void>): OpenedSession => ({
      sessionId: "claude-session-1",
      session: { ensureStarted },
      prompts: { sendPrompt: async () => undefined, interrupt: async () => undefined },
      stop: async () => undefined,
    });

    const withClaude = (opened: OpenedSession, sessionName = () => "fd-run-test") =>
      handlerWith({
        newSessionName: sessionName,
        run: { ...runEnvironment(new NodeFileSystem()), openSession: async () => opened },
      });

    it("announces the run's session name once Claude starts, and null when the run stops", async () => {
      handler = withClaude(claudeSession(async () => undefined));
      flows.save(promptFlow());
      const runId = await startedRunId();

      await vi.waitFor(() => {
        expect(sessionPushes(runId)).toEqual([{ push: "session", runId, value: "fd-run-test" }]);
      });

      await handler.stop();

      expect(sessionPushes(runId)).toEqual([
        { push: "session", runId, value: "fd-run-test" },
        { push: "session", runId, value: null },
      ]);
      expectOnlyBuildSessionsBesides(runId);
    });

    it("ends only the stopped run's session, leaving another build's session announced", async () => {
      let sessions = 0;
      handler = withClaude(
        claudeSession(async () => undefined),
        () => `fd-run-${++sessions}`,
      );
      flows.save(promptFlow());
      const a = await startedOn(await builtId());
      const b = await startedOn(await builtId());
      await vi.waitFor(() => {
        expect(sessionPushes(a)).toHaveLength(1);
        expect(sessionPushes(b)).toHaveLength(1);
      });

      await handler.handle({ id: nextId++, type: "stop-run", payload: { runId: a } });

      expect(sessionPushes(a).at(-1)).toEqual({ push: "session", runId: a, value: null });
      expect(sessionPushes(b)).toEqual([
        { push: "session", runId: b, value: runs.findRun(b)?.session.tmuxName },
      ]);
      expect(runs.findRun(b)?.status).toBe("running");
    });

    it("announces no session while Claude is still starting", async () => {
      let started: () => void = () => undefined;
      let starting = false;
      handler = withClaude(
        claudeSession(
          () =>
            new Promise<void>((resolve) => {
              starting = true;
              started = resolve;
            }),
        ),
      );
      flows.save(promptFlow());
      const runId = await startedRunId();

      await vi.waitFor(() => {
        expect(starting).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionPushes(runId)).toEqual([]);
      expectOnlyBuildSessionsBesides(runId);

      started();

      await vi.waitFor(() => {
        expect(sessionPushes(runId)).toEqual([{ push: "session", runId, value: "fd-run-test" }]);
      });
      expectOnlyBuildSessionsBesides(runId);
    });

    const namingJira = (): Flow => {
      const base = promptFlow();
      return { ...base, session: { connectors: ["jira"] } } as Flow;
    };

    it("starts and resumes a run's session with this machine's hook paths and no MCP config, though the build names an installed connector", async () => {
      const opened: OpenSessionOptions[] = [];
      handler = handlerWith({
        newSessionName: () => "fd-run-test",
        connectors: new FakeConnectorSource({ jira }),
        run: {
          ...runEnvironment(new NodeFileSystem()),
          openSession: async (opening) => {
            opened.push(opening);
            return claudeSession(async () => undefined);
          },
        },
      });
      flows.save(namingJira());
      const runId = await startedRunId();
      await vi.waitFor(() =>
        expect(runs.events(runId).map((event) => event.kind)).toContain("sent"),
      );
      await handler.handle({ id: nextId++, type: "stop-run", payload: { runId } });
      await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("stopped"));

      expect(
        await handler.handle({ id: nextId++, type: "resume-run", payload: { runId } }),
      ).toMatchObject({ ok: true, value: { kind: "started", runId } });
      await vi.waitFor(() => expect(opened).toHaveLength(2));

      expect(opened[0]).toMatchObject({
        hooks: { nodePath: process.execPath, hookScriptPath: `${home}/hooks/flowdeck-hook.cjs` },
      });
      expect(opened[1]).toMatchObject({ resume: true });
      for (const opening of opened) expect(opening).not.toHaveProperty("mcpConfigPath");
      expect(await new NodeFileSystem().exists(`${home}/runs/${runId}/mcp.json`)).toBe(false);
    });

    it("runs a build that names a connector Claude Code does not have", async () => {
      flows.save(namingJira());
      const buildId = await builtId();
      handler = handlerWith({
        connectors: new FakeConnectorSource(),
        run: {
          ...runEnvironment(new NodeFileSystem()),
          openSession: async () => claudeSession(async () => undefined),
        },
      });

      expect(await runBuild(buildId)).toMatchObject({ kind: "started" });
    });

    it("opens one build's sessions from its folder whatever node and hook paths this machine has", async () => {
      const openings: OpenSessionOptions[] = [];
      const machine = (nodePath: string) =>
        handlerWith({
          prepareHooks: () => ({
            kind: "ok",
            nodePath,
            hookScriptPath: `${nodePath}-hook.cjs`,
            guardScriptPath: `${nodePath}-guard.cjs`,
            webGuardScriptPath: `${nodePath}-web-guard.cjs`,
          }),
          run: {
            ...runEnvironment(new NodeFileSystem()),
            openSession: async (opening) => {
              openings.push(opening);
              return claudeSession(async () => undefined);
            },
          },
        });
      flows.save(promptFlow());
      const buildId = await builtId();

      handler = machine("/usr/local/bin/node");
      await startedOn(buildId);
      await vi.waitFor(() => expect(openings).toHaveLength(1));
      await handler.stop();
      handler = machine("/Users/someone/.nvm/versions/node/v24/bin/node");
      await startedOn(buildId);
      await vi.waitFor(() => expect(openings).toHaveLength(2));

      expect(openings.map((opening) => opening.workspaceFolder)).toEqual([
        workspaceFolder(buildDirOf(buildId)),
        workspaceFolder(buildDirOf(buildId)),
      ]);
      expect(openings.map((opening) => opening.hooks.nodePath)).toEqual([
        "/usr/local/bin/node",
        "/Users/someone/.nvm/versions/node/v24/bin/node",
      ]);
    });

    it("announces no session for a run with no Claude turn", async () => {
      flows.save(
        atRepo(
          onWorkspaceMainFlow([gate("g1", { settings: { shown: "Check", skippable: true } })], []),
        ),
      );

      const started = await runBuild(await builtId(), { auto: true });
      if (started.kind !== "started") throw new Error(`run did not start: ${started.message}`);
      const { runId } = started;
      await untilFinished(runId);
      expect(runs.findRun(runId)?.status).toBe("done");

      expect(sessionPushes(runId)).toEqual([]);
      expectOnlyBuildSessionsBesides(runId);
    });

    const startActivityRun = async (
      toolCall: (cwd: string) => Record<string, unknown> = () => ({
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    ) => {
      let clock = 1000;
      const source = new FakeEventSource();
      const planDone = {
        tool_name: "Agent",
        tool_input: { subagent_type: "fix-login:plan", prompt: "NODE plan\nGo" },
        tool_use_id: "toolu-plan",
        tool_response: { status: "completed", agentId: "agent-plan", agentType: "fix-login:plan" },
      };
      let claudeSessionId = "";
      let cwd = "";
      const hook = (kind: "PreToolUse" | "PostToolUse" | "Stop", sessionId: string, at: number) =>
        source.publish({
          kind,
          sessionId,
          payload: {
            hook_event_name: kind,
            session_id: sessionId,
            flowdeck_hook_at: at,
            ...(kind === "PreToolUse"
              ? toolCall(cwd)
              : kind === "PostToolUse"
                ? planDone
                : { last_assistant_message: "OK" }),
          },
        });
      handler = handlerWith({
        newSessionName: () => "fd-run-test",
        userHome: "/Users/me",
        run: {
          ...runEnvironment(new NodeFileSystem(), () => clock),
          startEvents: async () => ({ events: source, stop: async () => undefined }),
          openSession: async (opening) => {
            claudeSessionId = opening.claudeSessionId;
            cwd = opening.cwd;
            return {
              sessionId: claudeSessionId,
              session: { ensureStarted: async () => undefined },
              prompts: {
                interrupt: async () => undefined,
                sendPrompt: async () => {
                  clock = 1500;
                  hook("PreToolUse", claudeSessionId, 1200);
                  hook("PreToolUse", "another-session", 1300);
                  hook("PostToolUse", claudeSessionId, 1400);
                  hook("Stop", claudeSessionId, 1500);
                },
              },
              stop: async () => undefined,
            };
          },
        },
      });
      flows.save(promptFlow());

      const runId = await startedRunId();
      await untilFinished(runId);
      return { runId, claudeSessionId, hook };
    };

    const activityPushes = () => pushes.filter((push) => push.push === "activity");

    it("pushes one activity entry for a tool call of the run's Claude session stamped inside the node's turn", async () => {
      const { runId, claudeSessionId } = await startActivityRun();

      expect(claudeSessionId).toBe(runs.runs[0]?.session.claudeSessionId);
      expect(activityPushes()).toEqual([
        {
          push: "activity",
          value: {
            runId,
            entry: {
              id: 1,
              nodeId: "plan",
              at: 1200,
              kind: "tool",
              tool: "Bash",
              summary: "ls",
              input: '{"command":"ls"}',
            },
          },
        },
        {
          push: "activity",
          value: {
            runId,
            entry: { id: 2, nodeId: "plan", at: 1500, kind: "turn", summary: "OK" },
          },
        },
      ]);
    });

    it.each([
      ["src/a.ts", "src/a.ts"],
      ["/Users/me/.claude/notes.md", "outside the working folder: ~/.claude/notes.md"],
    ])(
      "shows a file the run wrote at %s as %s, against the build's worktree and home",
      async (path, shown) => {
        await startActivityRun((cwd) => ({
          tool_name: "Write",
          tool_input: { file_path: path.startsWith("/") ? path : `${cwd}/${path}` },
        }));

        expect(activityPushes()[0]?.value).toMatchObject({ entry: { kind: "tool", path: shown } });
      },
    );

    it("pushes no activity for a tool call that arrives after the run has finished", async () => {
      const { claudeSessionId, hook } = await startActivityRun();

      hook("PreToolUse", claudeSessionId, 1200);

      expect(activityPushes()).toHaveLength(2);
    });

    it("keeps no full text of a cut step folded while Flowdeck detaches", async () => {
      const source = new FakeEventSource();
      let releasePrompt: (() => void) | undefined;
      let claudeSessionId = "";
      const longCall = {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu-long",
      };
      const hook = (kind: "PreToolUse" | "PostToolUse", payload: Record<string, unknown>) =>
        source.publish({
          kind,
          sessionId: claudeSessionId,
          payload: {
            hook_event_name: kind,
            session_id: claudeSessionId,
            flowdeck_hook_at: 1200,
            ...payload,
          },
        });
      const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
      handler = handlerWith({
        newSessionName: () => "fd-run-test",
        run: {
          ...runEnvironment(new NodeFileSystem(), () => 1000),
          startEvents: async () => ({ events: source, stop: async () => undefined }),
          openSession: async (opening) => {
            claudeSessionId = opening.claudeSessionId;
            return {
              sessionId: claudeSessionId,
              session: { ensureStarted: async () => undefined },
              prompts: {
                interrupt: async () => undefined,
                sendPrompt: () => new Promise<void>((resolve) => (releasePrompt = resolve)),
              },
              stop: async () => undefined,
            };
          },
        },
      });
      flows.save(promptFlow());
      const runId = await startedRunId();
      await vi.waitFor(() => expect(releasePrompt).toBeDefined());

      const detaching = handler.detach();
      await vi.waitFor(() =>
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("detach waits up to")),
      );
      hook("PreToolUse", longCall);
      hook("PostToolUse", { ...longCall, tool_response: "x".repeat(5000) });
      releasePrompt?.();
      await detaching;

      expect(runs.activity(runId)).toEqual([]);
      expect(runs.stepTexts(runId, 1)).toEqual([]);
    });

    it("asks the run's waiter about a permission request from the run's Claude session", async () => {
      let clock = 1000;
      const source = new FakeEventSource();
      const permissions = new FakePermissionSource();
      const waiter = new FakeWaiter([{ decision: "approve" }]);
      let decision: unknown;
      handler = handlerWith({
        run: {
          ...runEnvironment(new NodeFileSystem(), () => clock),
          waiter,
          startEvents: async () => ({ events: source, permissions, stop: async () => undefined }),
          openSession: async (opening) => ({
            sessionId: opening.claudeSessionId,
            session: { ensureStarted: async () => undefined },
            prompts: {
              interrupt: async () => undefined,
              sendPrompt: async () => {
                decision = await permissions.ask(opening.claudeSessionId, {
                  hook_event_name: "PermissionRequest",
                  session_id: opening.claudeSessionId,
                  tool_name: "Bash",
                  tool_input: { command: "echo hi" },
                });
                clock = 1500;
                source.publish({
                  kind: "Stop",
                  sessionId: opening.claudeSessionId,
                  payload: {
                    hook_event_name: "Stop",
                    session_id: opening.claudeSessionId,
                    flowdeck_hook_at: 1500,
                    last_assistant_message: "OK",
                  },
                });
              },
            },
            stop: async () => undefined,
          }),
        },
      });
      flows.save(promptFlow());

      await untilFinished(await startedRunId());

      expect(waiter.calls).toEqual([
        { nodeId: "plan", kind: "permission", tool: "Bash", input: "echo hi" },
      ]);
      expect(decision).toEqual({ behavior: "allow" });
    });

    const gated = () =>
      atRepo(
        onWorkspaceMainFlow(
          [agent("s1"), gate("g1"), agent("s2")],
          [thenWire("s1", "g1"), thenWire("g1", "s2")],
        ),
      );

    const withAppWaiter = () =>
      handlerWith({ waits: createAppWaiter({ push: collectInto(pushes) }) });

    const waitPushes = (runId: string) =>
      pushes.flatMap((push) => (push.push === "wait" && push.runId === runId ? [push.value] : []));

    const openedWaitId = async (runId: string, nodeId: string) => {
      await vi.waitFor(() => {
        expect(waitPushes(runId).at(-1)?.request.nodeId).toBe(nodeId);
      });
      const opened = waitPushes(runId).at(-1);
      if (!opened) throw new Error(`no wait open for ${nodeId}`);
      return opened.waitId;
    };

    const answerWait = (payload: unknown) =>
      handler.handle({ id: nextId++, type: "answer-wait", payload });

    const parkedAtGate = async (runId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(snapshotsOf(runId).at(-1)).toEqual({
        runId,
        status: "running",
        nodes: {
          start: "done",
          s1: "done",
          g1: "needs-you",
          s2: "waiting",
          stop: "waiting",
          "session-1-start": "waiting",
          "session-1-stop": "waiting",
        },
      });
    };

    it("resumes a run parked at a gate when the open wait is approved", async () => {
      handler = withAppWaiter();
      flows.save(gated());
      const runId = await startedRunId();
      const waitId = await openedWaitId(runId, "g1");

      expect(await answerWait({ waitId, reply: { decision: "approve" } })).toEqual({
        id: nextId - 1,
        ok: true,
        value: { accepted: true },
      });

      await untilFinished(runId);
      expect(snapshotsOf(runId).at(-1)).toEqual({
        runId,
        status: "done",
        nodes: {
          start: "done",
          s1: "done",
          g1: "done",
          s2: "done",
          stop: "done",
          "session-1-start": "waiting",
          "session-1-stop": "waiting",
        },
      });
      expect(runs.events(runId)).toContainEqual(
        expect.objectContaining({
          nodeId: "g1",
          kind: "decided",
          payload: { nodeId: "g1", decision: "approved" },
        }),
      );
    });

    it("keeps one build's open wait when another build's run finishes, and still takes its answer", async () => {
      handler = withAppWaiter();
      flows.save(gated());
      const parkedBuild = await builtId();
      flows.save(twoAgents());
      const otherBuild = await builtId();
      const parked = await startedOn(parkedBuild);
      const waitId = await openedWaitId(parked, "g1");

      const other = await startedOn(otherBuild);
      await untilFinished(other);

      expect(snapshotsOf(other).at(-1)?.status).toBe("done");
      expect(waitPushes(parked).at(-1)).toEqual({
        waitId,
        request: expect.objectContaining({ nodeId: "g1" }),
      });
      expect(await answerWait({ waitId, reply: { decision: "approve" } })).toMatchObject({
        ok: true,
        value: { accepted: true },
      });
      await untilFinished(parked);
      expect(snapshotsOf(parked).at(-1)?.status).toBe("done");
    });

    it.each([
      ["a closed decision", (waitId: string) => ({ waitId, reply: { decision: "closed" } })],
      ["a malformed payload", (waitId: string) => ({ waitId, reply: "approve" })],
      ["a payload without a wait id", () => ({ reply: { decision: "approve" } })],
    ])("refuses %s and leaves the run parked at the gate", async (_name, payloadFor) => {
      handler = withAppWaiter();
      flows.save(gated());
      const runId = await startedRunId();
      const waitId = await openedWaitId(runId, "g1");

      expect(await answerWait(payloadFor(waitId))).toEqual({
        id: nextId - 1,
        ok: false,
        error: expect.stringMatching(/\S/),
      });

      await parkedAtGate(runId);
    });

    it("does not accept an answer with a stale wait id", async () => {
      handler = withAppWaiter();
      flows.save(gated());
      const runId = await startedRunId();
      const waitId = await openedWaitId(runId, "g1");

      expect(await answerWait({ waitId: `${waitId}-old`, reply: { decision: "approve" } })).toEqual(
        { id: nextId - 1, ok: true, value: { accepted: false } },
      );

      await parkedAtGate(runId);
    });

    it("drops the open wait when the run is stopped, and a late answer adds no events", async () => {
      handler = withAppWaiter();
      flows.save(gated());
      const runId = await startedRunId();
      const waitId = await openedWaitId(runId, "g1");

      await handler.stop();

      expect(waitPushes(runId).at(-1)).toBeNull();
      expect(runs.findRun(runId)?.status).toBe("stopped");
      const eventsAtStop = runs.events(runId);

      expect(await answerWait({ waitId, reply: { decision: "approve" } })).toEqual({
        id: nextId - 1,
        ok: true,
        value: { accepted: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs.events(runId)).toEqual(eventsAtStop);
      expect(runs.events(runId).filter((event) => event.kind === "decided")).toEqual([]);
    });

    it("does not accept an answer when the handler has no app waiter", async () => {
      expect(await answerWait({ waitId: "w1", reply: { decision: "approve" } })).toEqual({
        id: nextId - 1,
        ok: true,
        value: { accepted: false },
      });
      expect(pushes).toEqual([]);
    });

    it("leaves no unhandled rejection when reading the final status throws too", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        handler = withStartEvents(failingStartEvents);
        runs.finishRun = () => {
          throw new Error("database is locked");
        };
        runs.findRun = () => {
          throw new Error("database is locked");
        };
        flows.save(twoAgents());
        await startedRunId();

        await vi.waitFor(async () => {
          expect((await startRun()).kind).toBe("started");
        });
        await expect(handler.stop()).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });
});

describe("workspace-info", () => {
  const ask = (gitState: FakeGitState, payload: unknown) =>
    createEngineHandler(options({ gitState })).handle({ id: 9, type: "workspace-info", payload });

  it("answers the repository's git state and the default branch when no base is set", async () => {
    const gitState = new FakeGitState(
      { "/code/shop": { kind: "branch", name: "fd-demo" } },
      { defaultBranches: { "/code/shop": "dev" } },
    );

    expect(await ask(gitState, { buildConfig: { repo: "/code/shop" } })).toEqual({
      id: 9,
      ok: true,
      value: { state: { kind: "branch", name: "fd-demo" }, base: "dev" },
    });
    expect(gitState.reads).toEqual(["/code/shop"]);
  });

  it("answers the base the build configuration sets", async () => {
    const gitState = new FakeGitState(
      { "/code/shop": { kind: "branch", name: "fd-demo" } },
      { defaultBranches: { "/code/shop": "dev" } },
    );

    expect(await ask(gitState, { buildConfig: { repo: "/code/shop", base: "main" } })).toEqual({
      id: 9,
      ok: true,
      value: { state: { kind: "branch", name: "fd-demo" }, base: "main" },
    });
  });

  it("answers no repository with no state and reads no git", async () => {
    const gitState = new FakeGitState();

    expect(await ask(gitState, { buildConfig: {} })).toEqual({
      id: 9,
      ok: true,
      value: null,
    });
    expect(gitState.reads).toEqual([]);
  });

  it("refuses a payload that is not a build configuration and reads no git", async () => {
    const gitState = new FakeGitState();

    expect(await ask(gitState, { buildConfig: { repo: 5 } })).toMatchObject({
      id: 9,
      ok: false,
    });
    expect(gitState.reads).toEqual([]);
  });

  it("answers a git failure as an error instead of throwing", async () => {
    const gitState = new FakeGitState({}, { failWith: "spawn git ENOENT" });

    expect(await ask(gitState, { buildConfig: { repo: "/code/shop" } })).toEqual({
      id: 9,
      ok: false,
      error: "spawn git ENOENT",
    });
  });
});

describe("list-branches", () => {
  const ask = (gitState: FakeGitState, payload: unknown) =>
    createEngineHandler(options({ gitState })).handle({ id: 7, type: "list-branches", payload });

  it("answers a repository with its local branches", async () => {
    const gitState = new FakeGitState({}, { branches: { "/code/shop": ["dev", "main"] } });

    expect(await ask(gitState, { repo: "/code/shop" })).toEqual({
      id: 7,
      ok: true,
      value: ["dev", "main"],
    });
  });

  it("answers a git failure and a bad payload as errors", async () => {
    const failing = new FakeGitState({}, { failWith: "/code/shop is not a git repository" });

    expect(await ask(failing, { repo: "/code/shop" })).toEqual({
      id: 7,
      ok: false,
      error: "/code/shop is not a git repository",
    });
    expect(await ask(new FakeGitState(), {})).toMatchObject({ id: 7, ok: false });
  });
});

describe("checked-out-branches", () => {
  const ask = (gitState: FakeGitState, payload: unknown) =>
    createEngineHandler(options({ gitState })).handle({
      id: 8,
      type: "checked-out-branches" as never,
      payload,
    });

  it("answers a repository with each checked-out branch and the folder it is checked out in", async () => {
    const checkedOut = { main: "/code/shop", "feat-y": "/work/feat-y" };
    const gitState = new FakeGitState({}, { checkedOut: { "/code/shop": checkedOut } });

    expect(await ask(gitState, { repo: "/code/shop" })).toEqual({
      id: 8,
      ok: true,
      value: checkedOut,
    });
  });

  it("answers a git failure and a bad payload as errors", async () => {
    const failing = new FakeGitState({}, { failWith: "/code/shop is not a git repository" });

    expect(await ask(failing, { repo: "/code/shop" })).toEqual({
      id: 8,
      ok: false,
      error: "/code/shop is not a git repository",
    });
    expect(await ask(new FakeGitState(), {})).toMatchObject({ id: 8, ok: false });
  });
});

describe("doctor-worktrees", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("lists the per-run worktree folders an earlier Flowdeck left, and removes none", async () => {
    await mkdir(join(home, "worktrees", "1a2b3c4d"), { recursive: true });
    await mkdir(join(home, "worktrees", "5e6f7a8b"), { recursive: true });
    await writeFile(join(home, "worktrees", "5e6f7a8b", "work.txt"), "kept\n");
    const handler = createEngineHandler(options({ home }));

    const answer = await handler.handle({ id: 3, type: "doctor-worktrees" });

    expect(answer).toEqual({
      id: 3,
      ok: true,
      value: [join(home, "worktrees", "1a2b3c4d"), join(home, "worktrees", "5e6f7a8b")],
    });
    expect((await stat(join(home, "worktrees", "1a2b3c4d"))).isDirectory()).toBe(true);
    expect((await stat(join(home, "worktrees", "5e6f7a8b", "work.txt"))).isFile()).toBe(true);
  });

  it("lists nothing when no worktree folder was left", async () => {
    const handler = createEngineHandler(options({ home }));

    expect(await handler.handle({ id: 4, type: "doctor-worktrees" })).toEqual({
      id: 4,
      ok: true,
      value: [],
    });
  });
});

describe("default-branch", () => {
  const ask = (gitState: FakeGitState, payload: unknown) =>
    createEngineHandler(options({ gitState })).handle({ id: 6, type: "default-branch", payload });

  it("answers a repository's default branch through the git state", async () => {
    const gitState = new FakeGitState({}, { defaultBranches: { "/code/shop": "dev" } });

    expect(await ask(gitState, { repo: "/code/shop" })).toEqual({ id: 6, ok: true, value: "dev" });
  });

  it("answers a git failure and a bad payload as errors", async () => {
    const failing = new FakeGitState({}, { failWith: "/code/shop is not a git repository" });

    expect(await ask(failing, { repo: "/code/shop" })).toEqual({
      id: 6,
      ok: false,
      error: "/code/shop is not a git repository",
    });
    expect(await ask(new FakeGitState(), {})).toMatchObject({ id: 6, ok: false });
  });
});
