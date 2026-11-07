import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGoneError } from "../../../src/adapters/claude/claude-session.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";
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
  flow,
  fork,
  gate,
  join as joinNode,
  prompt,
  script,
  thenWire,
  wire,
} from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";
import { fakeEngineBuildOptions } from "../../fixtures/fake-build-deps.js";

const isFolder = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const sh = (id: string, command: string) =>
  script(id, { settings: { command: "sh", args: ["-c", command] } });

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

  const runEnvironment = (overrides: Partial<EngineHandlerOptions["run"]> = {}) => ({
    fs: new NodeFileSystem(),
    now: Date.now,
    scripts: new NodeProcessRunner(),
    waiter: new FakeWaiter([]),
    startEvents: async () => ({ events: new FakeEventSource(), stop: async () => undefined }),
    openSession: async (): Promise<OpenedSession> => {
      throw new Error("Claude must not start for a script-only flow");
    },
    ...overrides,
  });

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

  const cwdOf = (runId: string) => {
    const cwd = runs.findRun(runId)?.session.cwd;
    if (cwd === undefined || cwd === "") throw new Error(`run ${runId} has no folder`);
    return cwd;
  };

  const buildDirOf = (buildId: string) => {
    const built = runs.findBuild(buildId);
    if (built === undefined) throw new Error(`no build ${buildId}`);
    return built.dir;
  };

  const worktreeOf = (buildId: string) => join(buildDirOf(buildId), basename(repo.path));

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
      flow(
        [
          sh("s1", "true"),
          gate("g1", { settings: { shown: "Check", skippable: true } }),
          sh("s2", "true"),
        ],
        [thenWire("s1", "g1"), thenWire("g1", "s2")],
      );

    const branchOn = (variable: string) => {
      const base = flow(
        [branch("b", variable), sh("yes", "true"), sh("no", "true")],
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
    it("kills the running script and marks the run stopped, writing nothing after", async () => {
      const runId = await start(
        flow([sh("s1", "echo $$ > pid; exec sleep 30"), sh("s2", "true")], [thenWire("s1", "s2")]),
      );
      await vi.waitFor(async () =>
        expect(await readFile(join(cwdOf(runId), "pid"), "utf8").catch(() => "")).not.toBe(""),
      );
      const pid = Number(await readFile(join(cwdOf(runId), "pid"), "utf8"));

      expect(await call("stop-run", { runId })).toEqual({ stopped: true });

      expect(runs.findRun(runId)?.status).toBe("stopped");
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs.events(runId).map(({ nodeId, kind }) => `${nodeId} ${kind}`)).toEqual([
        "s1 running",
      ]);
    });

    it("answers not stopped for a run it does not know", async () => {
      expect(await call("stop-run", { runId: "nope" })).toEqual({ stopped: false });
    });

    describe("on a run left interrupted", () => {
      const interrupted = async (tmuxName: string) => {
        const buildId = await builtId(flow([sh("s1", "true")], []));
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
    const readsCode = () =>
      flow([sh("s1", "exit $(cat code.txt)"), sh("s2", "echo after")], [thenWire("s1", "s2")]);

    it("sends a failed script again once its file is fixed, and the run goes on to done", async () => {
      const buildId = await builtId(readsCode());
      const worktree = worktreeOf(buildId);
      await writeFile(join(worktree, "code.txt"), "3");
      const runId = await startOn(buildId);
      expect(await finished(runId)).toBe("failed");
      await writeFile(join(worktree, "code.txt"), "0");

      expect(started(await call("retry-node", { runId, nodeId: "s1" }))).toBe(runId);

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "s1")).toBe("done");
      expect(statusOf(runId, "s2")).toBe("done");
      expect(
        runs
          .events(runId)
          .filter((event) => event.nodeId === "s1")
          .map((event) => event.kind),
      ).toEqual(["running", "failed", "retry", "running", "done"]);
    });

    it("refuses a node that has not failed, and a run that is still going", async () => {
      const buildId = await builtId(readsCode());
      await writeFile(join(worktreeOf(buildId), "code.txt"), "3");
      const runId = await startOn(buildId);
      await finished(runId);

      expect(await call("retry-node", { runId, nodeId: "s2" })).toEqual({
        kind: "error",
        message: "s2 has not failed",
      });

      const going = await start(flow([sh("nap", "sleep 30")], []));
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
        flow(
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
      flow(
        [sh("s1", "echo once >> s1.log"), sh("s2", "test -f go || sleep 30"), sh("s3", "true")],
        [thenWire("s1", "s2"), thenWire("s2", "s3")],
      );

    it("goes on from a stopped run without running its finished nodes again", async () => {
      const runId = await start(stoppable());
      await vi.waitFor(() => expect(statusOf(runId, "s2")).toBe("running"));
      await call("stop-run", { runId });
      await writeFile(join(cwdOf(runId), "go"), "");

      expect(started(await call("resume-run", { runId }))).toBe(runId);

      expect(await finished(runId)).toBe("done");
      expect(await readFile(join(cwdOf(runId), "s1.log"), "utf8")).toBe("once\n");
      expect(["s1", "s2", "s3"].map((id) => statusOf(runId, id))).toEqual(["done", "done", "done"]);
    });

    it("refuses a stopped run while another run of its build is going, leaving it stopped", async () => {
      const buildId = await builtId(flow([sh("s1", "test -f go || sleep 30")], []));
      const first = await startOn(buildId);
      await vi.waitFor(() => expect(statusOf(first, "s1")).toBe("running"));
      await call("stop-run", { runId: first });
      const second = await startOn(buildId);

      expect(await call("resume-run", { runId: first })).toMatchObject({ kind: "error" });

      expect(runs.findRun(first)?.status).toBe("stopped");
      expect(runs.findRun(second)?.status).toBe("running");
    });

    it("refuses a run that is done", async () => {
      const runId = await start(flow([sh("s1", "true")], []));
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
      const runId = await start(flow([prompt("p1")], []));
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
      const runId = await start(flow([prompt("p1")], []));
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
    it("keeps a run's script output, and loads it again with the run", async () => {
      const runId = await start(flow([sh("s1", "echo hello; echo oops >&2")], []));
      await finished(runId);

      const loaded = (await call("load-run", { runId })) as { activity: unknown[] };

      expect(loaded.activity).toEqual([
        expect.objectContaining({ nodeId: "s1", kind: "output", stream: "stdout", text: "hello" }),
        expect.objectContaining({ nodeId: "s1", kind: "output", stream: "stderr", text: "oops" }),
      ]);
    });

    it("answers each node's tokens and cost, and a session total that is their sum", async () => {
      const runId = await start(flow([sh("s1", "true")], []));
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
        expect.objectContaining({ nodeId: "s1", tokens: 7, cost: 0.25 }),
      ]);
      expect(report.total).toMatchObject({ tokens: 7, cost: 0.25 });
    });
  });
});
