import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGoneError } from "../../../src/adapters/claude/claude-session.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { createAppWaiter } from "../../../src/app/engine/app-waiter.js";
import {
  createEngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import type { OpenSessionOptions, OpenedSession } from "../../../src/core/run/execute.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import {
  agent,
  branch,
  fork,
  gate,
  join as joinNode,
  onMainFlow,
  thenWire,
  wire,
} from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";
import { fakeEngineBuildOptions } from "../../fixtures/fake-build-deps.js";
import { fakeClaudeSession, type FakeTurnHandler } from "../../fixtures/fake-claude-session.js";

const isFolder = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

describe("run controls", () => {
  let home: string;
  let repo: TmpRepo;
  let runs: FakeStore;
  let flows: FakeFlowStore;
  let pushes: EnginePush[];
  let handler: ReturnType<typeof createEngineHandler>;
  let nextId: number;
  let names: number;
  let alive: Set<string>;
  let ended: string[];

  const atRepo = (input: Flow): Flow => ({
    ...input,
    session: { ...input.session, buildConfig: { ...input.session.buildConfig, repo: repo.path } },
  });

  const runEnvironment = (overrides: Partial<EngineHandlerOptions["run"]> = {}) => {
    const claude = fakeClaudeSession();
    return {
      fs: new NodeFileSystem(),
      now: Date.now,
      waiter: new FakeWaiter([]),
      startEvents: claude.startEvents,
      openSession: claude.openSession,
      ...overrides,
    };
  };

  const withClaude = (turn: FakeTurnHandler) => {
    const claude = fakeClaudeSession(turn);
    handler = handlerWith({
      run: runEnvironment({ startEvents: claude.startEvents, openSession: claude.openSession }),
    });
    return claude;
  };

  const handlerWith = (overrides: Partial<EngineHandlerOptions> = {}) =>
    createEngineHandler({
      version: "1.2.3",
      openStores: () => ({ runs, flows }),
      home,
      publish: (push) => pushes.push(push),
      prepareHooks: () => ({
        kind: "ok",
        nodePath: process.execPath,
        hookScriptPath: `${home}/hooks/flowdeck-hook.cjs`,
        guardScriptPath: `${home}/hooks/flowdeck-build-guard.cjs`,
      }),
      ...fakeEngineBuildOptions(new NodeFileSystem()),
      isFolder,
      fs: new NodeFileSystem(),
      connectors: new FakeConnectorSource(),
      run: runEnvironment(),
      worktree: new FakeWorktree(),
      gitState: new FakeGitState({ [repo.path]: { kind: "branch", name: "main" } }),
      transcriptTurns: async () => [],
      sessionAlive: async (name) => alive.has(name),
      endSession: async (name) => {
        ended.push(name);
        alive.delete(name);
      },
      ...overrides,
    });

  const call = async (type: string, payload?: unknown) => {
    const response = await handler.handle({
      id: nextId++,
      type: type as Parameters<typeof handler.handle>[0]["type"],
      payload,
    });
    if (!response.ok) throw new Error(response.error);
    return response.value as never;
  };

  const builtId = async (input: Flow, values: Record<string, unknown> = {}) => {
    const { flowId, version } = flows.save(atRepo(input));
    const name = `build-${++names}`;
    const answered = (await call("build-version", { flowId, version, name, values })) as {
      kind: string;
      pendingId: string;
      message?: string;
    };
    if (answered.kind !== "started") throw new Error(`did not build: ${answered.message}`);
    await vi.waitFor(() => {
      expect(runs.listPendingBuilds().map((open) => open.id)).not.toContain(answered.pendingId);
    });
    const built = runs.findBuildByName(name);
    if (built === undefined) throw new Error(`did not build ${name}`);
    return built.id;
  };

  const started = (result: { kind: string; runId?: string; message?: string }) => {
    if (result.kind !== "started" || result.runId === undefined) {
      throw new Error(`run did not start: ${result.message}`);
    }
    return result.runId;
  };

  const startOn = async (buildId: string, options: Record<string, unknown> = {}) =>
    started(await call("run-build", { buildId, ...options }));

  const start = async (input: Flow, options: Record<string, unknown> = {}) =>
    startOn(await builtId(input), options);

  const buildDirOf = (buildId: string) => {
    const built = runs.findBuild(buildId);
    if (built === undefined) throw new Error(`no build ${buildId}`);
    return built.dir;
  };

  const statusOf = (runId: string, nodeId: string) =>
    nodeStatus(runs.events(runId).filter((event) => event.nodeId === nodeId));

  const finished = async (runId: string) => {
    await vi.waitFor(() => expect(runs.findRun(runId)?.status).not.toBe("running"), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return runs.findRun(runId)?.status;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    runs = new FakeStore();
    flows = new FakeFlowStore();
    pushes = [];
    nextId = 1;
    names = 0;
    alive = new Set();
    ended = [];
    handler = handlerWith();
  });

  afterEach(async () => {
    await handler.stop();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  describe("run options", () => {
    const skippableGate = () =>
      onMainFlow(
        [agent("s1"), gate("g1", { settings: { shown: "Check", skippable: true } }), agent("s2")],
        [thenWire("s1", "g1"), thenWire("g1", "s2")],
      );

    const branchOn = (variable: string) => {
      const base = onMainFlow(
        [branch("b", variable), agent("yes"), agent("no")],
        [wire("b", "yes", "yes", "in"), wire("b", "no", "no", "in")],
      );
      return {
        ...base,
        session: {
          ...base.session,
          buildConfig: {
            ...base.session.buildConfig,
            variables: [{ name: variable, kind: "yesno" as const, default: true }],
          },
        },
      };
    };

    it("lets a run choose only automatic mode, and only for a build with a skippable gate", async () => {
      expect(await call("run-options", { buildId: await builtId(skippableGate()) })).toEqual({
        automatic: true,
      });
      expect(await call("run-options", { buildId: await builtId(branchOn("deep")) })).toEqual({
        automatic: false,
      });
    });

    it("passes a skippable gate in an automatic run, and stores the choice with the run", async () => {
      const runId = await start(skippableGate(), { auto: true });

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "g1")).toBe("skipped");
      expect(runs.findRun(runId)?.inputs).toEqual({ auto: true });
    });

    it("stops at a skippable gate in a normal run", async () => {
      handler = handlerWith({ waits: createAppWaiter({ push: (push) => pushes.push(push) }) });

      const runId = await start(skippableGate());

      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      expect(runs.findRun(runId)?.inputs).toEqual({});
    });

    it("takes Branch's path from the build's yes/no value, ignoring Trigger flags and inputs sent with the run", async () => {
      const buildId = await builtId(branchOn("deep"), { deep: false });

      const runId = await startOn(buildId, { inputs: { ticket: "FD-1" }, flags: { deep: true } });

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "yes")).toBe("skipped");
      expect(statusOf(runId, "no")).toBe("done");
      expect(runs.findRun(runId)?.inputs).toEqual({});
    });
  });

  describe("stop", () => {
    it("stops a run during an agent's turn and marks it stopped, writing nothing after", async () => {
      withClaude((nodeId) => (nodeId === "s1" ? "hold" : "done"));
      const runId = await start(onMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]));
      await vi.waitFor(() => expect(statusOf(runId, "s1")).toBe("sent"));

      expect(await call("stop-run", { runId })).toEqual({ stopped: true });

      expect(runs.findRun(runId)?.status).toBe("stopped");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs.events(runId).map(({ nodeId, kind }) => `${nodeId} ${kind}`)).toEqual([
        "start running",
        "start done",
        "s1 sent",
      ]);
    });

    it("answers not stopped for a run it does not know", async () => {
      expect(await call("stop-run", { runId: "nope" })).toEqual({ stopped: false });
    });

    describe("on a run left interrupted", () => {
      const interrupted = async (tmuxName: string) => {
        const buildId = await builtId(onMainFlow([agent("s1")], []));
        const { id } = runs.createRun({
          buildDir: buildDirOf(buildId),
          inputs: {},
          nodeIds: ["s1"],
          session: { tmuxName, cwd: repo.path, claudeSessionId: "c-left" },
          buildId,
        });
        return { buildId, runId: id };
      };

      it("marks it stopped and ends its live session, after which its build runs again", async () => {
        const { buildId, runId } = await interrupted("fd-run-left");
        alive.add("fd-run-left");

        expect(await call("stop-run", { runId })).toEqual({ stopped: true });

        expect(runs.findRun(runId)?.status).toBe("stopped");
        expect(ended).toEqual(["fd-run-left"]);
        expect(await finished(await startOn(buildId))).toBe("done");
      });

      it("marks it stopped without ending a session that has already ended", async () => {
        const { runId } = await interrupted("fd-run-gone");

        expect(await call("stop-run", { runId })).toEqual({ stopped: true });

        expect(runs.findRun(runId)?.status).toBe("stopped");
        expect(ended).toEqual([]);
      });

      it("never ends a session that is not one of Flowdeck's own", async () => {
        const { runId } = await interrupted("work");
        alive.add("work");

        await call("stop-run", { runId });

        expect(runs.findRun(runId)?.status).toBe("stopped");
        expect(ended).toEqual([]);
      });
    });
  });

  describe("retry", () => {
    const twoAgents = () => onMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]);

    it("sends a failed agent again, and the run goes on to done", async () => {
      let s1Turns = 0;
      withClaude((nodeId) => (nodeId === "s1" && ++s1Turns === 1 ? "fail" : "done"));
      const runId = await start(twoAgents());
      expect(await finished(runId)).toBe("failed");

      expect(started(await call("retry-node", { runId, nodeId: "s1" }))).toBe(runId);

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "s1")).toBe("done");
      expect(statusOf(runId, "s2")).toBe("done");
      expect(
        runs
          .events(runId)
          .filter((event) => event.nodeId === "s1")
          .map((event) => event.kind),
      ).toEqual(["sent", "failed", "retry", "sent", "done"]);
    });

    it("refuses a node that has not failed, and a run that is still going", async () => {
      withClaude((nodeId) => (nodeId === "s1" ? "fail" : nodeId === "nap" ? "hold" : "done"));
      const runId = await start(twoAgents());
      await finished(runId);

      expect(await call("retry-node", { runId, nodeId: "s2" })).toEqual({
        kind: "error",
        message: "s2 has not failed",
      });

      const going = await start(onMainFlow([agent("nap")], []));
      expect(await call("retry-node", { runId: going, nodeId: "nap" })).toMatchObject({
        kind: "error",
      });
    });

    it("reruns only the failed branch of a parallel section, and the join completes", async () => {
      const events = new FakeEventSource();
      const sent: string[] = [];
      let forkTurns = 0;
      const publish = (
        kind: "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse",
        sessionId: string,
        payload: object,
      ) =>
        events.publish({ kind, sessionId, payload: { ...payload, flowdeck_hook_at: Date.now() } });
      const fakeSession = (options: OpenSessionOptions): OpenedSession => ({
        sessionId: options.claudeSessionId,
        session: { ensureStarted: async () => undefined },
        prompts: {
          sendPrompt: async (text) => {
            sent.push(text);
            const calls = [
              ...text.matchAll(/subagent_type "([^"]+)" with the prompt "NODE (\w+)/g),
            ];
            const first = ++forkTurns === 1;
            setTimeout(() => {
              const id = options.claudeSessionId;
              for (const [, type, node] of calls) {
                publish("PreToolUse", id, {
                  tool_name: "Agent",
                  tool_input: { subagent_type: type, prompt: `NODE ${node}\nGo` },
                  tool_use_id: `toolu-${node}-${forkTurns}`,
                });
              }
              for (const [, type, node] of calls) {
                if (first && node === "b") continue;
                publish("PostToolUse", id, {
                  tool_name: "Agent",
                  tool_input: { subagent_type: type, prompt: `NODE ${node}\nGo` },
                  tool_use_id: `toolu-${node}-${forkTurns}`,
                  tool_response: {
                    status: "completed",
                    agentId: `agent-${node}`,
                    agentType: type,
                    content: [{ type: "text", text: `${node} reply` }],
                  },
                });
              }
              if (first) {
                publish("StopFailure", id, {
                  error: "server_error",
                  last_assistant_message: "API Error",
                });
              } else publish("Stop", id, { last_assistant_message: "Done." });
            }, 0);
          },
          interrupt: async () => undefined,
        },
        stop: async () => undefined,
      });
      handler = handlerWith({
        run: runEnvironment({
          startEvents: async () => ({ events, stop: async () => undefined }),
          openSession: async (options) => fakeSession(options),
        }),
      });
      const runId = await start(
        onMainFlow(
          [fork("f"), agent("a"), agent("b"), joinNode("j")],
          [thenWire("f", "a"), thenWire("f", "b"), thenWire("a", "j"), thenWire("b", "j")],
        ),
      );
      expect(await finished(runId)).toBe("failed");
      expect([statusOf(runId, "a"), statusOf(runId, "b")]).toEqual(["done", "failed"]);

      expect(started(await call("retry-node", { runId, nodeId: "b" }))).toBe(runId);

      await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"), {
        timeout: 15_000,
      });
      const kindsOf = (nodeId: string) =>
        runs
          .events(runId)
          .filter((event) => event.nodeId === nodeId)
          .map((event) => event.kind);
      expect(
        runs
          .events(runId)
          .filter((event) => event.kind === "retry")
          .map((event) => event.nodeId)
          .sort(),
      ).toEqual(["b", "f", "j"]);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain("NODE b");
      expect(sent[1]).not.toContain("NODE a");
      expect(kindsOf("a")).toEqual(["sent", "done"]);
      expect(kindsOf("b").slice(-3)).toEqual(["retry", "sent", "done"]);
      expect(statusOf(runId, "j")).toBe("done");
    }, 20_000);
  });

  describe("resume", () => {
    const stoppable = () =>
      onMainFlow(
        [agent("s1"), agent("s2"), agent("s3")],
        [thenWire("s1", "s2"), thenWire("s2", "s3")],
      );

    it("goes on from a stopped run without running its finished nodes again", async () => {
      let s2Turns = 0;
      const claude = withClaude((nodeId) => (nodeId === "s2" && ++s2Turns === 1 ? "hold" : "done"));
      const runId = await start(stoppable());
      await vi.waitFor(() => expect(statusOf(runId, "s2")).toBe("sent"));
      await call("stop-run", { runId });

      expect(started(await call("resume-run", { runId }))).toBe(runId);

      expect(await finished(runId)).toBe("done");
      expect(claude.sentTo("s1")).toHaveLength(1);
      expect(["s1", "s2", "s3"].map((id) => statusOf(runId, id))).toEqual(["done", "done", "done"]);
    });

    it("refuses a stopped run while another run of its build is going, leaving it stopped", async () => {
      withClaude(() => "hold");
      const buildId = await builtId(onMainFlow([agent("s1")], []));
      const first = await startOn(buildId);
      await vi.waitFor(() => expect(statusOf(first, "s1")).toBe("sent"));
      await call("stop-run", { runId: first });
      const second = await startOn(buildId);

      expect(await call("resume-run", { runId: first })).toMatchObject({ kind: "error" });

      expect(runs.findRun(first)?.status).toBe("stopped");
      expect(runs.findRun(second)?.status).toBe("running");
    });

    it("refuses a run that is done", async () => {
      const runId = await start(onMainFlow([agent("s1")], []));
      await finished(runId);

      expect(await call("resume-run", { runId })).toEqual({
        kind: "error",
        message: "Only a stopped or interrupted run can be resumed",
      });
    });

    const recordingSessions = (opened: OpenSessionOptions[]) =>
      runEnvironment({
        openSession: async (options) => {
          opened.push(options);
          if (options.attach === true) throw new SessionGoneError(options.sessionName);
          return {
            sessionId: options.claudeSessionId,
            session: { ensureStarted: async () => undefined },
            prompts: { sendPrompt: async () => undefined, interrupt: async () => undefined },
            stop: async () => undefined,
          };
        },
      });

    it("starts Claude again with --resume when the run's Claude session is gone", async () => {
      const opened: OpenSessionOptions[] = [];
      handler = handlerWith({ run: recordingSessions(opened), sessionAlive: async () => false });
      const runId = await start(onMainFlow([agent("p1")], []));
      await vi.waitFor(() => expect(statusOf(runId, "p1")).toBe("sent"));
      await call("stop-run", { runId });

      expect(started(await call("resume-run", { runId }))).toBe(runId);

      expect(opened.at(-1)).toMatchObject({ resume: true });
      expect(opened.at(-1)?.attach).toBeUndefined();
      await call("stop-run", { runId });
    });

    it("refuses, changing nothing, when the session ends between the check and the attach", async () => {
      const opened: OpenSessionOptions[] = [];
      handler = handlerWith({ run: recordingSessions(opened), sessionAlive: async () => true });
      const runId = await start(onMainFlow([agent("p1")], []));
      await vi.waitFor(() => expect(statusOf(runId, "p1")).toBe("sent"));
      await call("stop-run", { runId });
      const before = runs.events(runId);

      expect(await call("resume-run", { runId })).toEqual({
        kind: "error",
        message:
          "This run's Claude session ended just now. Resume again to start Claude on the same conversation.",
      });
      expect(opened.at(-1)?.attach).toBe(true);
      expect(runs.events(runId)).toEqual(before);
      expect(runs.findRun(runId)?.status).toBe("stopped");
    });
  });

  describe("activity and cost", () => {
    it("answers each node's tokens and cost, and a session total that is their sum", async () => {
      const runId = await start(onMainFlow([agent("s1")], []));
      await finished(runId);
      runs.append(runId, "s1", {
        kind: "usage",
        payload: { messages: ["m1"] },
        tokens: 7,
        cost: 0.25,
      });

      const report = (await call("run-cost", { runId })) as {
        nodes: { nodeId: string; tokens: number; cost: number }[];
        total: { tokens: number; cost: number };
      };

      expect(report.nodes).toEqual([
        expect.objectContaining({ nodeId: "start", tokens: 0, cost: 0 }),
        expect.objectContaining({ nodeId: "s1", tokens: 7, cost: 0.25 }),
        expect.objectContaining({ nodeId: "stop", tokens: 0, cost: 0 }),
      ]);
      expect(report.total).toMatchObject({ tokens: 7, cost: 0.25 });
    });
  });
});
