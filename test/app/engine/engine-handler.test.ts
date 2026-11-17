import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
import { hashBuild, sha256Hex } from "../../../src/core/compiler/hash.js";
import { lower } from "../../../src/core/compiler/lower.js";
import { flowSvg } from "../../../src/core/flow/flow-svg.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { markerOf } from "../../../src/core/run/agent-calls.js";
import { costOf, type UsageEntry } from "../../../src/core/run/budget.js";
import type { OpenSessionOptions, OpenedSession } from "../../../src/core/run/execute.js";
import type {
  BuildAgents,
  BuildAgentsOpenSpec,
  BuildTurnResult,
} from "../../../src/ports/build-agents.js";
import type { FlowStore } from "../../../src/ports/flow-store.js";
import type { WorktreeAddOptions } from "../../../src/ports/worktree.js";
import { FakeBuildAgents, type FakeBuildScript } from "../../fakes/fake-build-agents.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakePullRequests } from "../../fakes/fake-pull-requests.js";
import { FakeRunNarrator } from "../../fakes/fake-run-narrator.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeUsageSource } from "../../fakes/fake-usage-source.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import {
  agent,
  ask,
  flow,
  gate,
  loop,
  onMainFlow,
  output,
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
  flow(
    [trigger("start"), agent("plan"), output("stop")],
    [thenWire("start", "plan"), thenWire("plan", "stop")],
  );

const newBlueprint = () => ({ flowId: null, flow: savedFlow() });

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
      const second = onMainFlow([agent("other")], []);

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
      const second = onMainFlow([agent("other")], []);
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
      onMainFlow(
        [
          { ...agent("s1"), label: "Plan" },
          { ...agent("s2"), label: "Ship" },
        ],
        [thenWire("s1", "s2")],
      );

    const builtStages = {
      session: { name: "main" },
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
      runs.addSnapshotIfMissing(
        { pendingId: null, buildId: "b1" },
        { blueprintName: "Report", version, svg: flowSvg(built) },
      );
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

    const withoutManifest = (runs: FakeStore) => {
      runs.recordBuildWithoutManifest({
        id: "b2",
        hash: "h2",
        name: "before-manifests",
        repo: "/repo",
        base: "main",
        branch: "flowdeck/before-manifests",
        branchCreated: true,
        values: {},
        dir: "/fd-home/workspaces/b2",
        source: { flowId: "flow-a", version: 1 },
        files: [],
        nodes: [],
      });
      const { id: runId } = runs.createRun({
        buildDir: "/fd-home/workspaces/b2",
        inputs: {},
        nodeIds: ["s1", "s2"],
        session: {
          tmuxName: "fd-run-z",
          cwd: "/fd-home/workspaces/b2/repo",
          claudeSessionId: "c3",
        },
        buildId: "b2",
      });
      runs.finishRun(runId, "failed");
      return runId;
    };

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
        onMainFlow(
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

    it("loads a run of a build with no stored manifest with the build's name and no stages, reading no blueprint", async () => {
      const { runs } = seededRun();
      const runId = withoutManifest(runs);
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      const loaded = await handler.handle({ id: 1, type: "load-run", payload: { runId } });

      expect(loaded).toEqual({
        id: 1,
        ok: true,
        value: expect.objectContaining({ name: "before-manifests", stages: null }),
      });
      expect((loaded as { value: object }).value).not.toHaveProperty("flow");
    });

    it("gives a run of a build with no stored manifest a story digest with no session line", async () => {
      const { runs } = seededRun();
      const runId = withoutManifest(runs);
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      const loaded = await handler.handle({ id: 1, type: "load-run", payload: { runId } });

      expect(loaded).toMatchObject({
        ok: true,
        value: {
          story: {
            header: { name: "before-manifests" },
            digest: expect.stringContaining("Build: before-manifests"),
            written: null,
          },
        },
      });
      const { digest } = (loaded as { value: { story: { digest: string } } }).value.story;
      expect(digest).toContain("Run status: failed");
      expect(digest).not.toContain("Session:");
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
      const stages = (answered as { value: { nodeId: string; label: string; status: string }[] })
        .value;
      expect(stages.map(({ nodeId, label, status }) => ({ nodeId, label, status }))).toEqual([
        { nodeId: "start", label: "start", status: "waiting" },
        { nodeId: "s1", label: "Plan", status: "done" },
        { nodeId: "s2", label: "Ship", status: "waiting" },
        { nodeId: "stop", label: "stop", status: "waiting" },
      ]);
    });

    it("answers no pipeline for a run of a build with no stored manifest", async () => {
      const { runs } = seededRun();
      const runId = withoutManifest(runs);
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      expect(
        await handler.handle({ id: 1, type: "run-pipeline" as never, payload: { runId } }),
      ).toEqual({ id: 1, ok: true, value: null });
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

    it("answers the cost of a deleted build's run that has no stored manifest", async () => {
      const { runs } = seededRun();
      const runId = withoutManifest(runs);
      runs.append(runId, "s1", {
        kind: "usage",
        payload: { messages: [] },
        tokens: 40,
        cost: 0.12,
      });
      runs.deleteBuild("b2");
      const handler = createEngineHandler(
        options({ openStores: () => ({ runs, flows: unreadableFlows() }) }),
      );

      expect(await handler.handle({ id: 1, type: "run-cost", payload: { runId } })).toEqual({
        id: 1,
        ok: true,
        value: expect.objectContaining({
          nodes: [
            expect.objectContaining({ nodeId: "s1", tokens: 40, cost: 0.12 }),
            expect.objectContaining({ nodeId: "s2", tokens: 0, cost: 0 }),
          ],
          total: expect.objectContaining({ tokens: 40, cost: 0.12 }),
        }),
      });
    });

    describe("a run outlives its build", () => {
      const askedFlow = () =>
        onMainFlow(
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
              session: { name: "main" },
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
          (pipeline as { value: { nodeId: string; status: string }[] | null }).value?.map(
            ({ nodeId, status }) => ({ nodeId, status }),
          ),
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
  });

  describe("build-picture", () => {
    const pictured = () => onMainFlow([agent("draw")], []);

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
      runs.addSnapshotIfMissing(
        { pendingId: null, buildId: "b1" },
        { blueprintName: "Report", version: 1, svg: flowSvg(pictured()) },
      );
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

  describe("snapshots of builds made before them", () => {
    let dir: string;
    let db: ReturnType<typeof openDatabase>;
    let store: SqliteStore;
    let flows: SqliteFlowStore;
    const saved = () => onMainFlow([agent("old")], []);

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "fd-backfill-"));
      db = openDatabase({ path: join(dir, "flowdeck.db") });
      store = new SqliteStore({ db });
      flows = new SqliteFlowStore({ db, newId: () => "flow-old" });
      flows.create("Old report");
      const { version } = flows.save(saved(), "flow-old");
      store.recordBuild({
        id: "b-old",
        hash: "h-old",
        name: "old-build",
        repo: "/repo",
        base: "main",
        branch: "flowdeck/old-build",
        branchCreated: true,
        values: {},
        dir: join(dir, "workspaces", "b-old"),
        source: { flowId: "flow-old", version },
        files: [],
        nodes: [],
        manifest: "{}",
      });
    });

    afterEach(async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("gives an old build its snapshot before the first request is answered", async () => {
      const handler = createEngineHandler(options({ openStores: () => ({ runs: store, flows }) }));

      expect(await handler.handle({ id: 1, type: "list-builds" })).toEqual({
        id: 1,
        ok: true,
        value: [
          expect.objectContaining({
            id: "b-old",
            blueprintName: "Old report",
            blueprintVersion: 1,
          }),
        ],
      });
      expect(store.buildSnapshot({ buildId: "b-old" })).toEqual({
        pendingId: null,
        buildId: "b-old",
        blueprintName: "Old report",
        version: 1,
        svg: flowSvg(saved()),
      });
    });

    it("logs a blueprint that cannot be read while filling snapshots, and still answers", async () => {
      vi.spyOn(flows, "load").mockImplementation(() => {
        throw new Error("flow_versions is locked");
      });
      const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const handler = createEngineHandler(options({ openStores: () => ({ runs: store, flows }) }));

      expect(await handler.handle({ id: 1, type: "list-builds" })).toEqual({
        id: 1,
        ok: true,
        value: [expect.objectContaining({ id: "b-old", blueprintName: null })],
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("flow_versions is locked"));
      expect(store.buildSnapshot({ buildId: "b-old" })).toBeNull();
    });
  });

  describe("manifests of builds locked before they were kept", () => {
    let home: string;

    const lockedEarlier = async (runs: FakeStore, id: string, onDisk: string, locked: string) => {
      const dir = join(home, "workspaces", id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.json"), onDisk);
      runs.recordBuildWithoutManifest({
        id,
        hash: `h-${id}`,
        name: id,
        repo: "/repo",
        base: "main",
        branch: `flowdeck/${id}`,
        branchCreated: true,
        values: {},
        dir,
        files: [{ path: "manifest.json", sha256: sha256Hex(locked) }],
        nodes: [],
      });
    };

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "fd-manifests-"));
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("copies the manifest.json of a build whose folder still holds it as locked at engine start, and leaves one that changed", async () => {
      const runs = new FakeStore();
      const kept = manifestText(onMainFlow([agent("old")], []), "h-kept");
      const edited = manifestText(onMainFlow([agent("old")], []), "h-edited");
      await lockedEarlier(runs, "kept", kept, kept);
      await lockedEarlier(runs, "edited", `${edited}\n`, edited);
      const handler = createEngineHandler(
        options({ home, openStores: () => ({ runs, flows: new FakeFlowStore() }) }),
      );

      await handler.startUp();

      expect(runs.buildManifest("kept")).toBe(kept);
      expect(runs.buildManifest("edited")).toBeUndefined();
    });
  });

  describe("doctor", () => {
    it("reports installed connectors and the needed ones by name, without any setting's value", async () => {
      const handler = createEngineHandler(
        options({
          connectors: new FakeConnectorSource({
            jira,
            slack: { command: "slack-mcp", env: { SLACK_TOKEN: "xoxb-secret" } },
          }),
        }),
      );

      const answer = await handler.handle({
        id: 1,
        type: "doctor",
        payload: { connectors: ["slack", "linear"] },
      });

      expect(answer).toEqual({
        id: 1,
        ok: true,
        value: {
          installed: [
            { name: "jira", status: "ok", settings: [] },
            { name: "slack", status: "ok", settings: [{ name: "SLACK_TOKEN", set: true }] },
          ],
          needed: [
            expect.objectContaining({ name: "slack", status: "ok" }),
            expect.objectContaining({ name: "linear", status: "missing" }),
          ],
        },
      });
      expect(JSON.stringify(answer)).not.toContain("xoxb-secret");
    });

    it("answers a connector source that cannot be read as an error", async () => {
      const connectors = new FakeConnectorSource();
      connectors.list = () => Promise.reject(new Error("~/.claude.json is not valid JSON"));
      const handler = createEngineHandler(options({ connectors }));

      expect(await handler.handle({ id: 1, type: "doctor", payload: { connectors: [] } })).toEqual({
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

    const inFolder = (input: Flow, buildConfig: Flow["session"]["buildConfig"]): Flow => ({
      ...input,
      session: { ...input.session, buildConfig },
    });

    const atRepo = (input: Flow): Flow => inFolder(input, { repo: repo.path, variables: [] });

    const twoAgents = () =>
      atRepo(onMainFlow([agent("write"), agent("check")], [thenWire("write", "check")]));

    const sleeper = () => atRepo(onMainFlow([agent("nap")], []));

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
      join(buildDirOf(buildId), basename(from));

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
            onMainFlow(
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
          onMainFlow(
            v2.nodes.filter((node) => node.id === "write"),
            [],
          ),
        ),
      );

      const second = await startedRunId();
      await untilFinished(second);

      expect(runs.builds()).toHaveLength(2);
      expect(runs.findRun(second)?.nodeIds).toEqual(["start", "write", "stop"]);
      expect(Object.keys(snapshotsOf(second).at(-1)?.nodes ?? {})).toEqual([
        "start",
        "write",
        "stop",
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
          nodes: { start: "waiting", write: "waiting", check: "waiting", stop: "waiting" },
        },
      });
      await untilFinished(runId);
      expect(snapshotsOf(runId).at(-1)).toEqual({
        runId,
        status: "done",
        nodes: { start: "done", write: "done", check: "done", stop: "done" },
      });
      expect(runs.findRun(runId)?.status).toBe("done");
    });

    it("lists the active run as running and first, and an older run left running as interrupted", async () => {
      const seed = (buildId: string, status?: "done") => {
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
        expect(runs.findRun(a)?.session.cwd).toBe(worktreeOf(first));
        expect(runs.findRun(b)?.session.cwd).toBe(worktreeOf(second));
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
          flow(
            [trigger("start"), agent("plan"), output("stop")],
            [thenWire("start", "plan"), thenWire("plan", "stop")],
          ),
          {
            repo: source.path,
            base: "main",
            variables: [],
          },
        );

      const twoInSource = () =>
        inFolder(onMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]), {
          repo: source.path,
          base: "main",
          variables: [],
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

      it("runs the session in the build's worktree with the workspace layout, adding no worktree", async () => {
        const seen: OpenSessionOptions[] = [];
        handler = withRealWorktree(seen);
        flows.save(promptAt());
        const buildId = await builtId({ name: "fix-login" });
        const worktreesAtBuild = await worktreePaths(source.path);

        const runId = await startedOn(buildId);
        await untilFinished(runId);

        const worktree = sourceWorktreeOf(buildId);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          cwd: worktree,
          buildDir: runs.findBuild(buildId)?.dir,
          layout: "workspace",
        });
        expect(runs.findRun(runId)?.session.cwd).toBe(worktree);
        expect(await worktreePaths(source.path)).toEqual(worktreesAtBuild);
        expect(await flowdeckBranches()).toEqual([`flowdeck/fix-login-${buildId.slice(0, 8)}`]);
      });

      it("gives two runs of one build the same worktree", async () => {
        handler = withRealWorktree();
        flows.save(promptAt());
        const buildId = await builtId();

        await untilFinished(await startedOn(buildId));
        await untilFinished(await startedOn(buildId));

        expect(runs.runs.map((run) => run.session.cwd)).toEqual([
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
      flows.save(atRepo(onMainFlow([loop("retry", { settings: { cap: 0, onCap: "fail" } })], [])));

      await expectErrorAndNoRun(/^retry: Loop cap 0 is not a whole number of at least 1\./);
      expect(runs.builds()).toEqual([]);
    });

    it("lists every build problem with its node and field, and no rule ids", async () => {
      flows.save(
        atRepo(
          onMainFlow(
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
            path: join(dir, basename(repo.path)),
          },
        ]);

        expect(await handler.handle({ id: 2, type: "list-builds" })).toEqual({
          id: 2,
          ok: true,
          value: [
            expect.objectContaining({
              id,
              name: "fix-login",
              old: false,
              dir,
              createdAt: expect.any(Number),
              source: { flowId: "flow-1", version: 1 },
            }),
          ],
        });

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
          nodeIds: ["start", "write", "check", "stop"],
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
        const loose = flow([agent("loose")], []);
        flows.save({ ...main, nodes: [...main.nodes, ...loose.nodes] });
        const mainIds = main.nodes.map((node) => node.id);

        const buildId = await builtId();
        const manifest = JSON.parse(
          await new NodeFileSystem().readFile(`${buildDirOf(buildId)}/manifest.json`),
        ) as { nodes: { id: string }[] };
        const runId = await startedOn(buildId);
        await untilFinished(runId);

        expect(manifest.nodes.map((node) => node.id)).toEqual(mainIds);
        expect(runs.findRun(runId)?.nodeIds).toEqual(mainIds);
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

        readonly turn: BuildAgents["turn"] = async (sessionName, text, onCall) => {
          this.turnsStarted += 1;
          if (this.held) return new Promise<BuildTurnResult>(() => undefined);
          return this.fake.turn(sessionName, text, onCall);
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

      const startedPendingId = async (name = "fix-login", extra: { buildModel?: string } = {}) => {
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

      it("opens the build session with the blueprint's own model when the request names none", async () => {
        const pendingId = await startedPendingId();
        await endPush(pendingId);

        expect(agents.fake.opened.map((spec) => spec.model)).toEqual([undefined]);
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

      it("stops a build before its session opens: leaves neither its settings folder nor its workspace", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const asked: string[] = [];
        const gitState = gitAt(repo.path);
        gitState.defaultBranch = async (repoPath: string) => {
          asked.push(repoPath);
          await gate;
          return "main";
        };
        handler = handlerWith({
          buildAgents: agents,
          gitState,
          run: { ...runEnvironment(new NodeFileSystem()), usage },
        });
        const pendingId = await startedPendingId();
        await vi.waitFor(() => {
          expect(asked).toHaveLength(1);
        });

        const stopped = await handler.handle({
          id: nextId++,
          type: "build-stop",
          payload: { pendingId },
        });
        expect(stopped).toMatchObject({ ok: true });
        release();
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
          },
        });
        const saved = flows.save(
          inFolder(twoAgents(), { repo: source.path, base: "main", variables: [] }),
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
          },
        });
        const saved = flows.save(
          inFolder(twoAgents(), { repo: source.path, base: "main", variables: [] }),
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
          },
        });
        const saved = flows.save(
          inFolder(twoAgents(), { repo: source.path, base: "main", variables: [] }),
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
        const gitState = gitAt(repo.path);
        gitState.defaultBranch = async (repoPath: string) => {
          asked.push(repoPath);
          await gate;
          return "main";
        };
        handler = handlerWith({
          buildAgents: agents,
          gitState,
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

        it("stops a building row's build first, then hides the row and leaves no session or workspace folder", async () => {
          const { pendingId, opened } = await heldBuild();

          await deletePendingBuild(pendingId);

          expect(agents.fake.closed).toEqual([opened.sessionName]);
          expect(runs.pendingBuild(pendingId)?.outcome).toBe("stopped");
          expect(await progressIds()).not.toContain(pendingId);
          expect(runs.listLatestEndedPendingBuildsByName().map((ended) => ended.id)).toEqual([]);
          expect(await new NodeFileSystem().exists(dirname(opened.settingsPath))).toBe(false);
          expect(await new NodeFileSystem().exists(opened.workspaceDir)).toBe(false);
        });

        it("removes the build-sessions folder a building row's stop left behind", async () => {
          class KeepsFirstSessionFolder extends NodeFileSystem {
            private kept = false;

            override async removeTree(path: string, keep?: { keep?: string }): Promise<void> {
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
          "hides a row that ended %s, stopping nothing",
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
            expect(runs.pendingBuild(start.pendingId)?.outcome).toBe(outcome);
            expect(agents.fake.closed).toEqual([]);
          },
        );
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

        expect(await deleteBuild("build-pr")).toEqual({
          ok: true,
          kept: { kind: "branch", branch: "flowdeck/pr", reason: "open-pr" },
        });

        expect(pullRequests.calls).toEqual([{ repo: "/repos/app", branch: "flowdeck/pr" }]);
        expect(worktree.deletedRemoteBranches).toEqual([]);
      });

      it("previews whether deleting the build loses work in its worktree", async () => {
        const source = await createTmpRepo({ commit: true });
        try {
          handler = handlerWith({ worktree: new GitWorktree(), gitState: gitAt(source.path) });
          flows.save(inFolder(twoAgents(), { repo: source.path, base: "main", variables: [] }));
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
          flows.save(inFolder(twoAgents(), { repo: source.path, base: "main", variables: [] }));
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

      const deletedAt = (runId: string) =>
        (
          db.prepare("SELECT deleted_at FROM runs WHERE id = ?").get(runId) as {
            deleted_at: number | null;
          }
        ).deleted_at;

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

      it("hides an ended run from the list, keeps its row and status, and tells no further story", async () => {
        blueprints.save(twoAgents());
        const runId = await startedOn(await builtId());
        await untilFinished(runId);
        await vi.waitFor(() => expect(narrator.calls).toHaveLength(1));

        await deleteRun(runId);

        expect(listedIds()).not.toContain(runId);
        expect(deletedAt(runId)).toEqual(expect.any(Number));
        expect(store.findRun(runId)?.status).toBe("done");
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

      it("does not pick a deleted run up again when the engine reattaches", async () => {
        blueprints.save(sleeper());
        const runId = interrupted(await builtId());
        store.deleteRun(runId);
        const eventsBefore = store.events(runId);

        await handler.reattach();
        await settle();

        expect(store.events(runId)).toEqual(eventsBefore);
        expect(sessionPushes(runId)).toEqual([]);
        expect(snapshotsOf(runId)).toEqual([]);
      });
    });

    describe("an old hash-named build", () => {
      const legacyManifest = {
        version: 1,
        session: {
          name: "main",
          workingFolder: { kind: "worktree", branch: "main" },
          model: "sonnet",
          allowedTools: [],
          permissionMode: "default",
          connectors: [],
        },
        nodes: [
          { id: "s1", type: "gate", label: "s1", settings: { shown: "Check", skippable: false } },
        ],
        wires: [],
        files: {},
      };

      let db: ReturnType<typeof openDatabase>;
      let store: SqliteStore;
      let hash: string;
      let waiter: FakeWaiter;

      beforeEach(async () => {
        db = openDatabase({ path: join(home, "flowdeck.db") });
        store = new SqliteStore({ db });
        hash = hashBuild([{ path: "manifest.json", content: canonicalJson(legacyManifest) }]);
        const dir = join(home, "builds", hash);
        await new NodeFileSystem().writeFile(
          join(dir, "manifest.json"),
          canonicalJson({ ...legacyManifest, hash }),
        );
        db.prepare("INSERT INTO builds (id, hash, dir, created_at) VALUES (?, ?, ?, ?)").run(
          hash,
          hash,
          dir,
          1,
        );
        waiter = new FakeWaiter([{ decision: "approve" }]);
        handler = handlerWith({
          openStores: () => ({ runs: store, flows: new SqliteFlowStore({ db }) }),
          run: { ...runEnvironment(new NodeFileSystem()), waiter },
        });
      });

      afterEach(async () => {
        await handler.stop();
        db.close();
      });

      it("is listed and marked old", async () => {
        expect(await handler.handle({ id: 1, type: "list-builds" })).toEqual({
          id: 1,
          ok: true,
          value: [expect.objectContaining({ id: hash, name: null, old: true })],
        });
      });

      it("refuses a new run, pointing to a new build, and starts nothing", async () => {
        expect(await runBuild(hash)).toEqual({
          kind: "error",
          message: expect.stringContaining("Make a new build from this blueprint"),
        });
        expect(store.listRuns()).toEqual([]);
      });

      it("resumes a stopped run of it to the end", async () => {
        const { id: runId } = store.createRun({
          buildDir: join(home, "builds", hash),
          inputs: {},
          nodeIds: ["s1"],
          session: { tmuxName: "fd-run-old", cwd: repo.path, claudeSessionId: "c-old" },
          buildId: hash,
        });
        store.finishRun(runId, "stopped");

        expect(
          await handler.handle({ id: 1, type: "resume-run", payload: { runId } }),
        ).toMatchObject({ ok: true, value: { kind: "started", runId } });

        await vi.waitFor(() => expect(store.findRun(runId)?.status).toBe("done"));
        expect(waiter.calls.map(({ nodeId }) => nodeId)).toEqual(["s1"]);
      });

      it("refuses to resume a stopped run of it once deleted, naming the build by its id", async () => {
        const { id: runId } = store.createRun({
          buildDir: join(home, "builds", hash),
          inputs: {},
          nodeIds: ["s1"],
          session: { tmuxName: "fd-run-old", cwd: repo.path, claudeSessionId: "c-old" },
          buildId: hash,
        });
        store.finishRun(runId, "stopped");
        store.deleteBuild(hash);

        expect(
          await handler.handle({ id: 1, type: "resume-run", payload: { runId } }),
        ).toMatchObject({
          ok: true,
          value: { kind: "error", message: `No build ${hash}` },
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

      it("tells no story of a run whose build is not stored, logs why, and its page has no story", async () => {
        handler = storyHandler();
        const runId = runs.createRun({
          buildDir: "/fd-home/workspaces/gone",
          inputs: {},
          nodeIds: ["start"],
          session: { tmuxName: "left-gone", cwd: repo.path, claudeSessionId: "c-gone" },
          buildId: "gone",
        }).id;

        expect(await stopRunRequest(runId)).toMatchObject({ ok: true, value: { stopped: true } });

        await vi.waitFor(() => expect(storyNotWritten(runId)).toHaveLength(1));
        expect(storyNotWritten(runId)[0]).toMatch(/build is not stored/);
        expect(narrator.calls).toEqual([]);
        expect(appended()).toEqual([]);
        expect(await loadedStory(runId)).toBeUndefined();
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
        flow(
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

    it("gives the session the hook paths of this machine and the run's own private MCP config", async () => {
      const opened: OpenSessionOptions[] = [];
      const secretJira = { ...jira, headers: { Authorization: "Bearer s3cret" } };
      handler = handlerWith({
        newSessionName: () => "fd-run-test",
        connectors: new FakeConnectorSource({ jira: secretJira }),
        run: {
          ...runEnvironment(new NodeFileSystem()),
          openSession: async (opening) => {
            opened.push(opening);
            return claudeSession(async () => undefined);
          },
        },
      });
      const base = promptFlow();
      flows.save({ ...base, session: { ...base.session, connectors: ["jira"] } });

      const runId = await startedRunId();
      await vi.waitFor(() => expect(opened).toHaveLength(1));

      const runtimePath = `${home}/runs/${runId}/mcp.json`;
      expect(opened[0]).toMatchObject({
        hooks: { nodePath: process.execPath, hookScriptPath: `${home}/hooks/flowdeck-hook.cjs` },
        mcpConfigPath: runtimePath,
      });
      expect((await stat(runtimePath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await new NodeFileSystem().readFile(runtimePath))).toEqual({
        mcpServers: { jira: secretJira },
      });
      const [built] = runs.listBuilds();
      const files = await handler.handle({
        id: 90,
        type: "build-files",
        payload: { buildId: built?.id },
      });
      const listed = (files as { value: { path: string; content: string }[] }).value;
      expect(listed.map((file) => file.path)).not.toContain("mcp.json");
      expect(listed.filter((file) => file.content.includes("s3cret"))).toEqual([]);
    });

    it("refuses to run a build whose connector Claude Code no longer has, starting nothing", async () => {
      const opened: OpenSessionOptions[] = [];
      const base = promptFlow();
      flows.save({ ...base, session: { ...base.session, connectors: ["jira"] } });
      const buildId = await builtId();
      handler = handlerWith({
        connectors: new FakeConnectorSource(),
        run: {
          ...runEnvironment(new NodeFileSystem()),
          openSession: async (opening) => {
            opened.push(opening);
            return claudeSession(async () => undefined);
          },
        },
      });

      expect(await handler.handle({ id: 2, type: "run-build", payload: { buildId } })).toEqual({
        id: 2,
        ok: true,
        value: {
          kind: "error",
          message: expect.stringMatching(/^Connector "jira" is not set up in Claude Code/),
        },
      });
      expect(runs.runs).toEqual([]);
      expect(opened).toEqual([]);
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

      expect(openings.map((opening) => opening.buildDir)).toEqual([
        runs.findBuild(buildId)?.dir,
        runs.findBuild(buildId)?.dir,
      ]);
      expect(openings.map((opening) => opening.hooks.nodePath)).toEqual([
        "/usr/local/bin/node",
        "/Users/someone/.nvm/versions/node/v24/bin/node",
      ]);
    });

    it("announces no session for a run with no Claude turn", async () => {
      flows.save(
        atRepo(onMainFlow([gate("g1", { settings: { shown: "Check", skippable: true } })], [])),
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
            entry: { id: 1, nodeId: "plan", at: 1200, kind: "tool", tool: "Bash", summary: "ls" },
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
        onMainFlow(
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
        nodes: { start: "done", s1: "done", g1: "needs-you", s2: "waiting", stop: "waiting" },
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
        nodes: { start: "done", s1: "done", g1: "done", s2: "done", stop: "done" },
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

    expect(await ask(gitState, { buildConfig: { repo: "/code/shop", variables: [] } })).toEqual({
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

    expect(
      await ask(gitState, { buildConfig: { repo: "/code/shop", base: "main", variables: [] } }),
    ).toEqual({
      id: 9,
      ok: true,
      value: { state: { kind: "branch", name: "fd-demo" }, base: "main" },
    });
  });

  it("answers no repository with no state and reads no git", async () => {
    const gitState = new FakeGitState();

    expect(await ask(gitState, { buildConfig: { variables: [] } })).toEqual({
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

    expect(await ask(gitState, { buildConfig: { repo: "/code/shop", variables: [] } })).toEqual({
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
