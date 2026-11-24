import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { createAppWaiter, type AppWaiter } from "../../../src/app/engine/app-waiter.js";
import {
  createEngineHandler,
  type EngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import type { OpenSessionOptions, OpenedSession } from "../../../src/core/run/execute.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import type { PendingWait } from "../../../src/core/run/wait.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakePullRequests } from "../../fakes/fake-pull-requests.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import {
  agent,
  gate,
  onWorkspaceMainFlow,
  output,
  sessionsWorkflow,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";
import { fakeEngineBuildOptions } from "../../fixtures/fake-build-deps.js";
import { FakeBuildAgents } from "../../fakes/fake-build-agents.js";
import type { BuildAgents, BuildTurnResult } from "../../../src/ports/build-agents.js";
import type { FlowStore } from "../../../src/ports/flow-store.js";

const git = async (repo: string, ...args: string[]): Promise<string> =>
  (await promisify(execFile)("git", ["-C", repo, ...args])).stdout;

const worktreeCount = async (repo: string): Promise<number> =>
  (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

const flowdeckBranches = async (repo: string): Promise<string[]> =>
  (await git(repo, "branch", "--list", "--format=%(refname:short)"))
    .split("\n")
    .filter((branch) => branch.startsWith("flowdeck/"));

const isFolder = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

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

const inRepo = (input: Flow, repo: string): Flow => ({
  ...input,
  containers: input.containers.map((container) =>
    container.kind === "session" ? { ...container, repo } : container,
  ),
});

const dispatched = /subagent_type "([^"]+)" and the prompt "NODE ([^\\"]+)/;

describe("an app restart", () => {
  let home: string;
  let repo: TmpRepo;
  let runs: FakeStore;
  let flows: FlowStore;
  let pushes: EnginePush[];
  let events: FakeEventSource;
  let opened: OpenSessionOptions[];
  let stops: string[];
  let alive: Set<string>;
  let waiter: AppWaiter;
  let handlers: EngineHandler[];
  let nextId: number;
  let sending: { started: number; held?: Promise<void> };
  let names: number;

  const fakeSession = (options: OpenSessionOptions): OpenedSession => ({
    sessionId: options.claudeSessionId,
    session: { ensureStarted: async () => undefined },
    prompts: {
      sendPrompt: async (text) => {
        sending.started++;
        await sending.held;
        const [, agentType, nodeId] = dispatched.exec(text) ?? [];
        setTimeout(() => {
          if (nodeId !== undefined) {
            events.publish({
              kind: "PostToolUse",
              sessionId: options.claudeSessionId,
              payload: {
                tool_name: "Agent",
                tool_input: { subagent_type: agentType, prompt: `NODE ${nodeId}\nGo` },
                tool_use_id: `toolu-${nodeId}`,
                tool_response: { status: "completed", agentId: `agent-${nodeId}`, agentType },
              },
            });
          }
          events.publish({ kind: "Stop", sessionId: options.claudeSessionId, payload: {} });
        }, 0);
      },
      interrupt: async () => undefined,
    },
    stop: async () => {
      stops.push(options.sessionName);
    },
  });

  const newHandler = (
    overrides: Partial<EngineHandlerOptions> = {},
    runOverrides: Partial<EngineHandlerOptions["run"]> = {},
  ) => {
    waiter = createAppWaiter({ push: (push) => pushes.push(push) });
    const handler = createEngineHandler({
      version: "1.2.3",
      openStores: () => ({ runs, flows }),
      home,
      publish: (push) => pushes.push(push),
      prepareHooks: () => ({
        kind: "ok",
        nodePath: process.execPath,
        hookScriptPath: `${home}/hooks/flowdeck-hook.cjs`,
        guardScriptPath: `${home}/hooks/flowdeck-build-guard.cjs`,
        webGuardScriptPath: `${home}/hooks/flowdeck-web-guard.cjs`,
      }),
      ...fakeEngineBuildOptions(new NodeFileSystem()),
      isFolder,
      fs: new NodeFileSystem(),
      connectors: new FakeConnectorSource(),
      run: {
        fs: new NodeFileSystem(),
        now: Date.now,
        waiter: new FakeWaiter([]),
        startEvents: async () => ({ events, stop: async () => undefined }),
        openSession: async (options) => {
          opened.push(options);
          return fakeSession(options);
        },
        ...runOverrides,
      },
      waits: waiter,
      sessionAlive: async (name) => alive.has(name),
      worktree: new FakeWorktree(),
      gitState: new FakeGitState({ [repo.path]: { kind: "branch", name: "main" } }),
      pullRequests: new FakePullRequests(),
      claudeConfig: {
        projectsDir: `${home}/claude/projects`,
        claudeJson: `${home}/claude/.claude.json`,
      },
      transcriptTurns: async () => [],
      ...overrides,
    });
    handlers.push(handler);
    return handler;
  };

  const call = async (handler: EngineHandler, type: string, payload?: unknown) => {
    const response = await handler.handle({
      id: nextId++,
      type: type as Parameters<EngineHandler["handle"]>[0]["type"],
      payload,
    });
    if (!response.ok) throw new Error(response.error);
    return response.value as never;
  };

  const start = async (handler: EngineHandler, input: Flow) => {
    const { flowId, version } = flows.save(inRepo(input, repo.path));
    const name = `build-${++names}`;
    const answered = (await call(handler, "build-version", {
      flowId,
      version,
      name,
      values: {},
    })) as { kind: string; pendingId: string; message?: string };
    if (answered.kind !== "started") throw new Error(`did not build: ${answered.message}`);
    await vi.waitFor(() => {
      expect(runs.listPendingBuilds().map((open) => open.id)).not.toContain(answered.pendingId);
    });
    const built = runs.findBuildByName(name);
    if (built === undefined) throw new Error(`did not build ${name}`);
    const result = (await call(handler, "run-build", { buildId: built.id })) as {
      kind: string;
      runId: string;
      message?: string;
    };
    if (result.kind !== "started") throw new Error(`run did not start: ${result.message}`);
    return result.runId;
  };

  const statusOf = (runId: string, nodeId: string) =>
    nodeStatus(runs.events(runId).filter((event) => event.nodeId === nodeId));
  const kindsOf = (runId: string, nodeId: string) =>
    runs
      .events(runId)
      .filter((event) => event.nodeId === nodeId)
      .map((event) => event.kind);
  const lastWait = (runId: string) =>
    pushes.findLast(
      (push): push is Extract<EnginePush, { push: "wait" }> =>
        push.push === "wait" && push.runId === runId,
    )?.value as PendingWait | null | undefined;
  const sessionName = (runId: string) => runs.findRun(runId)?.session.tmuxName ?? "";

  const workspaceAsks = (): Flow => {
    const built = sessionsWorkflow(
      [
        { name: "android", repo: repo.path, branch: "main" },
        { name: "ios", repo: repo.path, branch: "main" },
      ],
      { workspace: ["Plan"] },
    );
    const check = gate("workspace-1-check", { settings: { shown: "Check android" } });
    return parseFlow({
      ...built,
      nodes: [...built.nodes, check],
      wires: [
        ...built.wires.filter(
          (each) => !(each.from.node === "workspace-1-plan" && each.to.node === "workspace-1-stop"),
        ),
        thenWire("workspace-1-plan", check.id),
        thenWire(check.id, "workspace-1-stop"),
      ],
      containers: built.containers.map((container) =>
        container.kind === "workspace"
          ? { ...container, nodes: [...container.nodes, check.id] }
          : container,
      ),
    });
  };

  const containerSession = (slug: string) => {
    const env = (opened[0] as (OpenSessionOptions & { env?: Record<string, string> }) | undefined)
      ?.env;
    return {
      tmuxName: env?.[`FD_SESSION_${slug}_TMUX`] ?? "",
      claudeSessionId: env?.[`FD_SESSION_${slug}_ID`] ?? "",
    };
  };

  const agentHook = (kind: "PreToolUse" | "PostToolUse" | "Stop", sessionId: string, nodeId = "") =>
    events.publish({
      kind,
      sessionId,
      payload: {
        hook_event_name: kind,
        session_id: sessionId,
        ...(kind === "Stop"
          ? { last_assistant_message: "DONE" }
          : {
              tool_name: "Agent",
              tool_input: { subagent_type: "agent", prompt: `NODE ${nodeId}\nGo` },
              tool_use_id: `toolu-${nodeId}`,
              ...(kind === "PostToolUse"
                ? { tool_response: { status: "completed", agentId: `agent-${nodeId}` } }
                : {}),
            }),
      },
    });

  const askedAtGate = () =>
    onWorkspaceMainFlow(
      [agent("p1"), gate("g1", { settings: { shown: "Check the plan" } }), agent("s2")],
      [thenWire("p1", "g1"), thenWire("g1", "s2")],
    );

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    runs = new FakeStore();
    flows = new FakeFlowStore();
    pushes = [];
    events = new FakeEventSource();
    opened = [];
    stops = [];
    alive = new Set();
    handlers = [];
    nextId = 1;
    sending = { started: 0 };
    names = 0;
  });

  afterEach(async () => {
    for (const handler of handlers) await handler.stop();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  describe("quitting", () => {
    it("leaves the run, its session and the open question as they are", async () => {
      const first = newHandler();
      const runId = await start(first, askedAtGate());
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      const before = runs.events(runId);

      await first.detach();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(stops).toEqual([]);
      expect(runs.findRun(runId)?.status).toBe("running");
      expect(runs.events(runId)).toEqual(before);
    });

    it("waits for a prompt still being sent before letting go of the run", async () => {
      let release: () => void = () => undefined;
      sending.held = new Promise((resolve) => (release = resolve));
      const first = newHandler();
      await start(first, onWorkspaceMainFlow([agent("p1")], []));
      await vi.waitFor(() => expect(sending.started).toBe(1));
      let detached = false;

      const detaching = first.detach().then(() => (detached = true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(detached).toBe(false);
      release();
      await detaching;

      expect(detached).toBe(true);
    });

    it("stops waiting for a prompt that never finishes sending after 8 seconds", async () => {
      sending.held = new Promise(() => undefined);
      const first = newHandler();
      await start(first, onWorkspaceMainFlow([agent("p1")], []));
      await vi.waitFor(() => expect(sending.started).toBe(1));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let detached = false;
        const detaching = first.detach().then(() => (detached = true));

        await vi.advanceTimersByTimeAsync(7_900);
        expect(detached).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        await detaching;
        expect(detached).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("starting again", () => {
    it("reattaches a run whose session is alive, asks its open question again, and finishes it", async () => {
      const first = newHandler();
      const runId = await start(first, askedAtGate());
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      await first.detach();
      alive.add(sessionName(runId));
      pushes = [];

      const second = newHandler();
      await second.reattach();

      expect(opened.at(-1)).toMatchObject({ attach: true, sessionName: sessionName(runId) });
      expect(pushes).toContainEqual({ push: "session", runId, value: sessionName(runId) });
      await vi.waitFor(() => expect(lastWait(runId)?.request).toMatchObject({ nodeId: "g1" }));
      const runsListed = (await call(second, "list-runs")) as { id: string; status: string }[];
      expect(runsListed.find((run) => run.id === runId)?.status).toBe("running");

      expect(
        waiter.answer({ waitId: lastWait(runId)?.waitId ?? "", reply: { decision: "approve" } }),
      ).toBe(true);

      await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"));
      expect(kindsOf(runId, "p1").filter((kind) => kind === "sent")).toHaveLength(1);
      expect(statusOf(runId, "s2")).toBe("done");
    });

    it("reattaches the workspace and every started session, listening to each again, and never reattaches or ends one never started", async () => {
      const asked: string[] = [];
      const ended: string[] = [];
      const first = newHandler();
      const runId = await start(first, workspaceAsks());
      await vi.waitFor(() => expect(statusOf(runId, "workspace-1-check")).toBe("needs-you"));
      const android = containerSession("ANDROID");
      const ios = containerSession("IOS");
      agentHook("PreToolUse", android.claudeSessionId, "session-1-plan");
      await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("running"));
      await first.detach();
      alive.add(sessionName(runId));
      alive.add(android.tmuxName);
      events = new FakeEventSource();
      pushes = [];

      const second = newHandler({
        sessionAlive: async (name) => {
          asked.push(name);
          return alive.has(name);
        },
        endSession: async (name) => {
          ended.push(name);
          alive.delete(name);
        },
      });
      await second.reattach();

      expect(asked).toEqual(expect.arrayContaining([sessionName(runId), android.tmuxName]));
      expect(asked).not.toContain(ios.tmuxName);
      agentHook("PostToolUse", android.claudeSessionId, "session-1-plan");
      agentHook("Stop", android.claudeSessionId);
      await vi.waitFor(() => expect(statusOf(runId, "session-1-stop")).toBe("done"));
      await vi.waitFor(() =>
        expect(lastWait(runId)?.request).toMatchObject({ nodeId: "workspace-1-check" }),
      );
      waiter.answer({ waitId: lastWait(runId)?.waitId ?? "", reply: { decision: "approve" } });
      await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"));
      expect(ended).not.toContain(ios.tmuxName);
      expect(statusOf(runId, "session-2-start")).toBe("waiting");
    });

    it("leaves a run interrupted, with a plain note, when its session has ended", async () => {
      const first = newHandler();
      const runId = await start(first, askedAtGate());
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      await first.detach();
      const openedBefore = opened.length;

      const second = newHandler();
      await second.reattach();

      expect(opened).toHaveLength(openedBefore);
      const loaded = (await call(second, "load-run", { runId })) as {
        run: { status: string };
        note?: string;
      };
      expect(loaded.run.status).toBe("interrupted");
      expect(loaded.note).toBe(
        "Flowdeck closed while this run was going, and its Claude session has ended since. Resume starts Claude again on the same conversation.",
      );
    });

    it("resumes across the ended session by starting Claude again with --resume", async () => {
      const first = newHandler();
      const runId = await start(
        first,
        onWorkspaceMainFlow(
          [agent("p1"), gate("g1"), agent("p2")],
          [thenWire("p1", "g1"), thenWire("g1", "p2")],
        ),
      );
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      await first.detach();
      const second = newHandler();
      await second.reattach();
      pushes = [];

      expect(await call(second, "resume-run", { runId })).toEqual({ kind: "started", runId });
      await vi.waitFor(() => expect(lastWait(runId)?.request).toMatchObject({ nodeId: "g1" }));
      waiter.answer({ waitId: lastWait(runId)?.waitId ?? "", reply: { decision: "approve" } });

      await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"));
      expect(opened.at(-1)).toMatchObject({ resume: true, sessionName: sessionName(runId) });
      expect(opened.at(-1)?.attach).toBeUndefined();
      expect(kindsOf(runId, "p1").filter((kind) => kind === "sent")).toHaveLength(1);
    });

    it("reattaches every run left going, asks each one's question again, and finishes both", async () => {
      const first = newHandler();
      const one = await start(first, askedAtGate());
      const two = await start(first, askedAtGate());
      await vi.waitFor(() => {
        expect(statusOf(one, "g1")).toBe("needs-you");
        expect(statusOf(two, "g1")).toBe("needs-you");
      });
      await first.detach();
      alive.add(sessionName(one));
      alive.add(sessionName(two));
      pushes = [];

      const second = newHandler();
      await second.reattach();

      expect(opened.filter((options) => options.attach === true).map((o) => o.sessionName)).toEqual(
        expect.arrayContaining([sessionName(one), sessionName(two)]),
      );
      await vi.waitFor(() => {
        expect(lastWait(one)?.request).toMatchObject({ nodeId: "g1" });
        expect(lastWait(two)?.request).toMatchObject({ nodeId: "g1" });
      });
      const listed = (await call(second, "list-runs")) as { id: string; status: string }[];
      expect(
        listed.filter((run) => run.id === one || run.id === two).map((run) => run.status),
      ).toEqual(["running", "running"]);

      for (const runId of [one, two]) {
        expect(
          waiter.answer({ waitId: lastWait(runId)?.waitId ?? "", reply: { decision: "approve" } }),
        ).toBe(true);
      }

      await vi.waitFor(() => {
        expect(runs.findRun(one)?.status).toBe("done");
        expect(runs.findRun(two)?.status).toBe("done");
      });
    });

    it("still reattaches the other runs when one left going has lost its session", async () => {
      const first = newHandler();
      const ended = await start(first, askedAtGate());
      const going = await start(first, askedAtGate());
      await vi.waitFor(() => {
        expect(statusOf(ended, "g1")).toBe("needs-you");
        expect(statusOf(going, "g1")).toBe("needs-you");
      });
      await first.detach();
      alive.add(sessionName(going));

      const second = newHandler();
      await second.reattach();

      expect(opened.at(-1)).toMatchObject({ attach: true, sessionName: sessionName(going) });
      await vi.waitFor(() => expect(lastWait(going)?.request).toMatchObject({ nodeId: "g1" }));
      const loaded = (await call(second, "load-run", { runId: ended })) as {
        run: { status: string };
      };
      expect(loaded.run.status).toBe("interrupted");
    });

    it("leaves every run alone while another Flowdeck holds the home", async () => {
      const first = newHandler();
      const runId = await start(first, askedAtGate());
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      await first.detach();
      alive.add(sessionName(runId));
      const before = runs.events(runId);
      const openedBefore = opened.length;
      pushes = [];

      const second = newHandler({ homeLock: { acquire: async () => false } });
      await second.reattach();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(opened).toHaveLength(openedBefore);
      expect(pushes).toEqual([]);
      expect(runs.findRun(runId)?.status).toBe("running");
      expect(runs.events(runId)).toEqual(before);
    });

    it("reattaches once it holds the home", async () => {
      const first = newHandler();
      const runId = await start(first, askedAtGate());
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      await first.detach();
      alive.add(sessionName(runId));

      const second = newHandler({ homeLock: { acquire: async () => true } });
      await second.reattach();

      expect(opened.at(-1)).toMatchObject({ attach: true, sessionName: sessionName(runId) });
    });

    it("does not mark a run failed when its event socket cannot be opened", async () => {
      const first = newHandler();
      const runId = await start(first, askedAtGate());
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      await first.detach();
      alive.add(sessionName(runId));
      let tried = false;

      const second = newHandler(
        {},
        {
          startEvents: async () => {
            tried = true;
            throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
          },
        },
      );
      await second.reattach();
      await vi.waitFor(() => expect(tried).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(runs.findRun(runId)?.status).toBe("running");
    });

    it("does nothing when no run was left going", async () => {
      const handler = newHandler();

      await handler.reattach();

      expect(pushes).toEqual([]);
      expect(opened).toEqual([]);
    });
  });

  describe("a build left going", () => {
    type ProgressPush = Extract<EnginePush, { push: "build-progress" }>;

    class InFlightAgents implements BuildAgents {
      readonly fake = new FakeBuildAgents({ fs: new NodeFileSystem() });

      readonly open: BuildAgents["open"] = (spec) => this.fake.open(spec);

      readonly turn: BuildAgents["turn"] = async (sessionName, text, onCall) => {
        await this.fake.turn(sessionName, text, onCall);
        return new Promise<BuildTurnResult>(() => undefined);
      };

      readonly alive: BuildAgents["alive"] = (sessionName) => this.fake.alive(sessionName);

      readonly close: BuildAgents["close"] = (sessionName) => this.fake.close(sessionName);
    }

    const leftMidTurn = async (
      overrides: Partial<EngineHandlerOptions> = {},
      repoPath = repo.path,
      request: Record<string, unknown> = {},
      blueprint: Flow = onWorkspaceMainFlow([agent("p1")], []),
    ) => {
      const inFlight = new InFlightAgents();
      const first = newHandler({ buildAgents: inFlight, ...overrides });
      const { flowId, version } = flows.save(inRepo(blueprint, repoPath));
      const name = "left-going";
      const answered = (await call(first, "build-version", {
        flowId,
        version,
        name,
        values: {},
        ...request,
      })) as { kind: string; pendingId: string; message?: string };
      if (answered.kind !== "started") throw new Error(`did not build: ${answered.message}`);
      await vi.waitFor(() => expect(inFlight.fake.turns).toHaveLength(1));
      const [spec] = inFlight.fake.opened;
      if (spec === undefined) throw new Error("the build session never opened");
      await first.detach();
      return { pendingId: answered.pendingId, name, spec };
    };

    const onExistingBranch = { branch: { mode: "existing", name: "feat-y" } };

    const withFeatY = (repoPath: string) =>
      new FakeGitState(
        { [repoPath]: { kind: "branch", name: "main" } },
        { branches: { [repoPath]: ["main", "feat-y"] } },
      );

    const sessionEventsWithoutBranch = () => {
      const stored = runs.buildEvents.bind(runs);
      vi.spyOn(runs, "buildEvents").mockImplementation((pendingId) =>
        stored(pendingId).map((event) => {
          if (event.type !== "session") return event;
          const old = { ...event };
          delete old.branch;
          delete old.branchCreated;
          return old;
        }),
      );
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
    };

    const finishedAfterRestart = async (
      spec: { sessionName: string; claudeSessionId: string },
      name: string,
      overrides: Partial<EngineHandlerOptions> = {},
    ) => {
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });
      const second = newHandler({ buildAgents: after, ...overrides });
      await second.reattach();
      await vi.waitFor(() => expect(after.opened).toHaveLength(1));
      events.publish({ kind: "Stop", sessionId: spec.claudeSessionId, payload: {} });
      await vi.waitFor(() => expect(runs.findBuildByName(name)).toBeDefined(), { timeout: 3000 });
      const built = runs.findBuildByName(name);
      if (built === undefined) throw new Error(`did not build ${name}`);
      return built;
    };

    const stepEvents = (pendingId: string) =>
      runs.buildEvents(pendingId).flatMap((event) => (event.type === "step" ? [event] : []));

    const endPush = (pendingId: string) =>
      pushes.findLast(
        (push): push is ProgressPush =>
          push.push === "build-progress" &&
          push.pendingId === pendingId &&
          push.progress.outcomeLabel !== undefined,
      );

    it("reattaches a build whose session is alive: announces it, waits for the turn's Stop, then carries on to the end", async () => {
      const { pendingId, name, spec } = await leftMidTurn();
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });
      const worktree = new FakeWorktree();
      pushes = [];

      const second = newHandler({ buildAgents: after, worktree });
      await second.reattach();

      expect(pushes).toContainEqual({ push: "session", runId: pendingId, value: spec.sessionName });
      await vi.waitFor(() => expect(after.opened).toHaveLength(1));
      expect(after.opened[0]).toMatchObject({
        attach: true,
        sessionName: spec.sessionName,
        claudeSessionId: spec.claudeSessionId,
        workspaceDir: spec.workspaceDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(after.turns).toEqual([]);
      expect(runs.listPendingBuilds().map((open) => open.id)).toContain(pendingId);

      events.publish({ kind: "Stop", sessionId: spec.claudeSessionId, payload: {} });

      await vi.waitFor(() => expect(runs.findBuildByName(name)).toBeDefined(), { timeout: 3000 });
      expect(runs.listPendingBuilds()).toEqual([]);
      expect(after.turns.length).toBeGreaterThan(0);
      expect(after.turns.every((turn) => turn.sessionName === spec.sessionName)).toBe(true);
      const steps = stepEvents(pendingId);
      for (const step of [1, 2] as const) {
        expect(
          steps.filter((event) => event.step === step && event.status === "running"),
        ).toHaveLength(1);
      }
      expect(
        steps.filter((event) => event.step === 3 && event.status === "done" && event.round === 1),
      ).toHaveLength(1);
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Built · v1" });
      expect(worktree.calls).toEqual([]);
    });

    it("resumes a build mid step 3 from the blueprint version it started from, under its snapshot's name", async () => {
      const { pendingId, name, spec } = await leftMidTurn();
      const pending = runs.pendingBuild(pendingId);
      const snapshot = runs.buildSnapshot({ pendingId });
      if (pending === null || snapshot === null) throw new Error("the build kept no snapshot");
      flows.rename(pending.flowId, "Renamed since");
      flows.save(
        onWorkspaceMainFlow([agent("p1"), agent("s2")], [thenWire("p1", "s2")]),
        pending.flowId,
      );
      const loaded = vi.spyOn(flows, "load");
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });
      pushes = [];

      const second = newHandler({ buildAgents: after });
      await second.reattach();
      await vi.waitFor(() => expect(after.opened).toHaveLength(1));
      events.publish({ kind: "Stop", sessionId: spec.claudeSessionId, payload: {} });

      await vi.waitFor(() => expect(runs.findBuildByName(name)).toBeDefined(), { timeout: 3000 });
      expect(loaded).toHaveBeenCalledWith({ flowId: pending.flowId, version: pending.version });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Built · v1" });
      const built = runs.findBuildByName(name);
      const recorded = runs.builds().find((build) => build.id === built?.id);
      expect(recorded?.nodes.map((node) => node.nodeId)).toEqual([
        "start",
        "p1",
        "stop",
        "session-1-start",
        "session-1-stop",
      ]);
      const claudeMd = await new NodeFileSystem().readFile(
        join(built?.dir ?? "", "sessions/main/CLAUDE.md"),
      );
      expect(claudeMd.split("\n").filter((line) => line.startsWith("- Blueprint: "))).toEqual([
        `- Blueprint: ${snapshot.blueprintName}, version ${snapshot.version}`,
      ]);
    });

    it("finishes a build left going from the flow it froze, not from its library's later save", async () => {
      const nodeLibrary = (label: string): Flow =>
        parseFlow({
          nodes: [trigger("canvas-start"), { ...agent("plan"), label }, output("canvas-stop")],
          wires: [thenWire("canvas-start", "plan"), thenWire("plan", "canvas-stop")],
          containers: [],
          settings: onWorkspaceMainFlow([], []).settings,
        });
      const library = flows.save(nodeLibrary("Planner"), { name: "Android" });
      flows.save(onWorkspaceMainFlow([agent("p1")], []), { name: "Host" });
      const use = {
        id: "use",
        label: "Library",
        position: { x: 0, y: 0 },
        type: "library",
        settings: { libraryId: library.flowId, label: "Android App", overrides: {} },
      };
      const { name, spec } = await leftMidTurn(
        {},
        repo.path,
        {},
        onWorkspaceMainFlow([agent("p1"), use], [thenWire("p1", "use")]),
      );
      flows.save(nodeLibrary("Reviewer"), library.flowId);

      const built = await finishedAfterRestart(spec, name);

      const manifest = JSON.parse(runs.buildManifest(built.id) ?? "{}") as {
        containers: { nodes: { id: string; label: string }[] }[];
      };
      expect(
        manifest.containers
          .flatMap((container) => container.nodes)
          .find((node) => node.id === "android-app-plan")?.label,
      ).toBe("Planner");
    });

    it.each([
      { blueprints: "returns no version", broken: () => new FakeFlowStore() },
      { blueprints: "throws on every call", broken: unreadableFlows },
    ])(
      "ends a build left mid step 3 failed, tearing down, when the blueprint store $blueprints",
      async ({ broken }) => {
        const { pendingId, spec } = await leftMidTurn();
        alive.add(spec.sessionName);
        const after = new FakeBuildAgents({
          fs: new NodeFileSystem(),
          script: { aliveAfterRestart: true },
        });
        flows = broken();
        pushes = [];

        const second = newHandler({ buildAgents: after });
        await second.reattach();

        await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
        expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
        expect(after.opened).toEqual([]);
        expect(after.turns).toEqual([]);
        expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
        expect(runs.listBuilds()).toEqual([]);
        expect(await call(second, "build-progress-list")).toEqual([
          expect.objectContaining({ pendingId, outcome: "failed" }),
        ]);
      },
    );

    it("reattaches a build on an existing branch and finishes it on that branch", async () => {
      const onFeatY = { gitState: withFeatY(repo.path) };
      const { name, spec } = await leftMidTurn(onFeatY, repo.path, onExistingBranch);

      const built = await finishedAfterRestart(spec, name, onFeatY);

      expect(built).toMatchObject({ branch: "feat-y", branchCreated: false });
      const claudeMd = await new NodeFileSystem().readFile(
        join(built.dir, "sessions/main/CLAUDE.md"),
      );
      expect(claudeMd.split("\n").filter((line) => line.startsWith("- Branch: "))).toEqual([
        "- Branch: feat-y (existing)",
      ]);
    });

    it("reattaches a build whose session event names no branch on the branch its name gives", async () => {
      const { name, spec } = await leftMidTurn();
      sessionEventsWithoutBranch();

      const built = await finishedAfterRestart(spec, name);

      expect(built).toMatchObject({
        branch: `flowdeck/${name}-${built.id.slice(0, 8)}`,
        branchCreated: true,
      });
    });

    it("ends a build left going with no snapshot failed, saying the snapshot is missing", async () => {
      const startPendingBuild = runs.startPendingBuild.bind(runs);
      vi.spyOn(runs, "startPendingBuild").mockImplementation(
        ({ flowId, version, name, origin, startedAt }) =>
          startPendingBuild({ flowId, version, name, origin, startedAt }),
      );
      const { pendingId, spec } = await leftMidTurn();
      expect(runs.buildSnapshot({ pendingId })).toBeNull();
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });
      flows = new FakeFlowStore();
      const logged = vi.spyOn(console, "log");
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      pushes = [];

      const second = newHandler({ buildAgents: after });
      await second.reattach();

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`build ${pendingId} not reattached \\(.*snapshot`)),
      );
      expect(after.turns).toEqual([]);
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
    });

    it("gives a reattached rebuild's step-4 audit the answers its origin keeps", async () => {
      const question = { nodeId: "p1", text: "Which file does p1 write its plan to?" };
      const answer = { ...question, answer: "p1 writes plan.md and nothing else." };
      const asking = newHandler({
        buildAgents: new FakeBuildAgents({
          fs: new NodeFileSystem(),
          script: { questions: [question] },
        }),
      });
      const blueprint = onWorkspaceMainFlow([agent("p1")], []);
      const { flowId, version } = flows.save(inRepo(blueprint, repo.path));
      const asked = (await call(asking, "build-version", {
        flowId,
        version,
        name: "asked",
        values: {},
      })) as { pendingId: string };
      await vi.waitFor(() =>
        expect(
          runs.listLatestEndedPendingBuildsByName().find((ended) => ended.id === asked.pendingId)
            ?.outcome,
        ).toBe("needs-you"),
      );
      const inFlight = new InFlightAgents();
      const first = newHandler({ buildAgents: inFlight });
      const rebuilt = (await call(first, "build-rebuild", {
        pendingId: asked.pendingId,
        answers: [answer],
      })) as { kind: string; pendingId: string };
      expect(rebuilt.kind).toBe("started");
      await vi.waitFor(() => expect(inFlight.fake.turns).toHaveLength(1));
      expect(inFlight.fake.turns[0]?.text).toContain(answer.answer);
      const [spec] = inFlight.fake.opened;
      if (spec === undefined) throw new Error("the rebuild's session never opened");
      await first.detach();
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });

      const second = newHandler({ buildAgents: after });
      await second.reattach();
      await vi.waitFor(() => expect(after.opened).toHaveLength(1));
      events.publish({ kind: "Stop", sessionId: spec.claudeSessionId, payload: {} });

      await vi.waitFor(() => expect(runs.findBuildByName("asked")).toBeDefined(), {
        timeout: 3000,
      });
      const audit = after.turns.find((turn) => turn.text.includes("handoff-auditor"));
      expect(audit?.text).toContain(answer.text);
      expect(audit?.text).toContain(answer.answer);
    });

    it.each([
      { ended: true, waits: false },
      { ended: false, waits: true },
    ])(
      "with the in-flight turn in the transcript and ended $ended, waits for a Stop: $waits",
      async ({ ended, waits }) => {
        const { pendingId, name, spec } = await leftMidTurn();
        alive.add(spec.sessionName);
        const after = new FakeBuildAgents({
          fs: new NodeFileSystem(),
          script: { aliveAfterRestart: true },
        });
        pushes = [];

        const second = newHandler({
          buildAgents: after,
          transcriptTurns: async (claudeSessionId) =>
            claudeSessionId === spec.claudeSessionId ? [{ userText: "build turn", ended }] : [],
        });
        await second.reattach();

        if (waits) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(after.turns).toEqual([]);
          events.publish({ kind: "Stop", sessionId: spec.claudeSessionId, payload: {} });
        }
        await vi.waitFor(() => expect(runs.findBuildByName(name)).toBeDefined(), { timeout: 3000 });
        expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Built · v1" });
      },
    );

    it("ends a reattached build failed when its in-flight turn ends in a StopFailure, tearing down", async () => {
      const { pendingId, spec } = await leftMidTurn();
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });
      pushes = [];

      const second = newHandler({ buildAgents: after });
      await second.reattach();
      await vi.waitFor(() => expect(after.opened).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));

      events.publish({
        kind: "StopFailure",
        sessionId: spec.claudeSessionId,
        payload: { error: "API Error: overloaded" },
      });

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(stepEvents(pendingId).at(-1)).toMatchObject({
        status: "failed",
        message: "API Error: overloaded",
      });
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
      expect(after.turns).toEqual([]);
      expect(after.closed).toEqual([spec.sessionName]);
      expect(runs.listBuilds()).toEqual([]);
    });

    it("ends a reattached build failed when its session ends while the in-flight turn is awaited", async () => {
      const { pendingId, spec } = await leftMidTurn();
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });
      let sessionUp = true;
      const dying: BuildAgents = {
        open: (opened) => after.open(opened),
        turn: (sessionName, text, onCall) => after.turn(sessionName, text, onCall),
        alive: async (sessionName) => sessionUp && (await after.alive(sessionName)),
        close: (sessionName) => after.close(sessionName),
      };
      pushes = [];

      const second = newHandler({ buildAgents: dying, buildSessionPollMs: 5 });
      await second.reattach();
      await vi.waitFor(() => expect(after.opened).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs.listPendingBuilds().map((open) => open.id)).toContain(pendingId);

      sessionUp = false;

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(stepEvents(pendingId).at(-1)).toMatchObject({
        status: "failed",
        message: "the build session ended",
      });
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
      expect(after.turns).toEqual([]);
      expect(runs.listBuilds()).toEqual([]);
    });

    it("ends a build left past its step-3 turn failed, closing its live session and tearing down", async () => {
      const { pendingId, spec } = await leftMidTurn();
      runs.appendBuildEvent(pendingId, { type: "step", step: 3, status: "done", round: 1 });
      runs.appendBuildEvent(pendingId, { type: "step", step: 4, status: "running" });
      alive.add(spec.sessionName);
      const after = new FakeBuildAgents({
        fs: new NodeFileSystem(),
        script: { aliveAfterRestart: true },
      });
      pushes = [];

      const second = newHandler({ buildAgents: after });
      await second.reattach();

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(after.closed).toEqual([spec.sessionName]);
      expect(after.opened).toEqual([]);
      expect(after.turns).toEqual([]);
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
      expect(runs.listBuilds()).toEqual([]);
    });

    it("ends a build whose session has ended failed, tears its workspace down, and starts no session", async () => {
      const { pendingId, spec } = await leftMidTurn();
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(true);
      expect(await new NodeFileSystem().exists(spec.settingsPath)).toBe(true);
      const after = new FakeBuildAgents({ fs: new NodeFileSystem() });
      pushes = [];

      const second = newHandler({ buildAgents: after });
      await second.reattach();

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
      expect(await new NodeFileSystem().exists(dirname(spec.settingsPath))).toBe(false);
      expect(after.opened.filter((opened) => !("attach" in opened))).toEqual([]);
      expect(after.turns).toEqual([]);
      expect(runs.listBuilds()).toEqual([]);
    });

    it("ends a build left in step 3 failed, removing its worktree registration, branch and workspace", async () => {
      const source = await createTmpRepo({ commit: true });
      onTestFinished(() => source.cleanup());
      const onGit = {
        worktree: new GitWorktree(),
        gitState: new FakeGitState({ [source.path]: { kind: "branch", name: "main" } }),
      };
      const { pendingId, spec } = await leftMidTurn(onGit, source.path);
      expect(await worktreeCount(source.path)).toBe(2);
      expect(await flowdeckBranches(source.path)).toHaveLength(1);
      pushes = [];

      const second = newHandler({
        buildAgents: new FakeBuildAgents({ fs: new NodeFileSystem() }),
        ...onGit,
      });
      await second.reattach();

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(await worktreeCount(source.path)).toBe(1);
      expect(await flowdeckBranches(source.path)).toEqual([]);
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
    });

    it("ends a build left in step 3 failed, removing the branch its name gives when its session event names none", async () => {
      const source = await createTmpRepo({ commit: true });
      onTestFinished(() => source.cleanup());
      const onGit = {
        worktree: new GitWorktree(),
        gitState: new FakeGitState({ [source.path]: { kind: "branch", name: "main" } }),
      };
      const { pendingId } = await leftMidTurn(onGit, source.path);
      expect(await flowdeckBranches(source.path)).toHaveLength(1);
      sessionEventsWithoutBranch();

      const second = newHandler({
        buildAgents: new FakeBuildAgents({ fs: new NodeFileSystem() }),
        ...onGit,
      });
      await second.reattach();

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(await worktreeCount(source.path)).toBe(1);
      expect(await flowdeckBranches(source.path)).toEqual([]);
    });

    it("ends a build left in step 3 with a worktree per session container failed, removing every worktree", async () => {
      const worktree = new FakeWorktree();
      const twoSessions = sessionsWorkflow([
        { name: "android", repo: repo.path, branch: "main" },
        { name: "ios", repo: repo.path, branch: "main" },
      ]);
      const { pendingId, spec } = await leftMidTurn({ worktree }, repo.path, {}, twoSessions);
      const cut = worktree.calls.map((added) => added.path);
      expect(cut).toEqual([
        join(spec.workspaceDir, "sessions/android", basename(repo.path)),
        join(spec.workspaceDir, "sessions/ios", basename(repo.path)),
      ]);

      const second = newHandler({
        buildAgents: new FakeBuildAgents({ fs: new NodeFileSystem() }),
        worktree,
      });
      await second.reattach();

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(worktree.removed.map((removed) => removed.path)).toEqual(cut);
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
    });

    it("ends a build left in step 3 on an existing branch failed, removing its worktree and keeping the branch", async () => {
      const source = await createTmpRepo({ commit: true });
      onTestFinished(() => source.cleanup());
      await git(source.path, "branch", "feat-y");
      const onGit = { worktree: new GitWorktree(), gitState: withFeatY(source.path) };
      const { pendingId, spec } = await leftMidTurn(onGit, source.path, onExistingBranch);
      expect(await git(source.path, "worktree", "list", "--porcelain")).toContain(
        "branch refs/heads/feat-y",
      );
      pushes = [];

      const second = newHandler({
        buildAgents: new FakeBuildAgents({ fs: new NodeFileSystem() }),
        ...onGit,
      });
      await second.reattach();

      await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 3000 });
      expect(endPush(pendingId)?.progress).toMatchObject({ outcomeLabel: "Failed" });
      expect(await worktreeCount(source.path)).toBe(1);
      expect(await git(source.path, "branch", "--list", "feat-y")).toContain("feat-y");
      expect(await flowdeckBranches(source.path)).toEqual([]);
      expect(await new NodeFileSystem().exists(spec.workspaceDir)).toBe(false);
    });
  });
});
