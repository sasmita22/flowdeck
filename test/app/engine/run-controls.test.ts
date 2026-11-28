import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
import type { PipelineGroup } from "../../../src/core/run/pipeline.js";
import { cutOffMessage } from "../../../src/core/run/resume.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakePullRequests } from "../../fakes/fake-pull-requests.js";
import { FakeRunNarrator } from "../../fakes/fake-run-narrator.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import {
  agent,
  branch,
  fork,
  gate,
  join as joinNode,
  onWorkspaceMainFlow,
  sessionsWorkflow,
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
    containers: input.containers.map((container) =>
      container.kind === "session" ? { ...container, repo: repo.path } : container,
    ),
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
        webGuardScriptPath: `${home}/hooks/flowdeck-web-guard.cjs`,
      }),
      ...fakeEngineBuildOptions(new NodeFileSystem()),
      isFolder,
      fs: new NodeFileSystem(),
      connectors: new FakeConnectorSource(),
      run: runEnvironment(),
      worktree: new FakeWorktree(),
      gitState: new FakeGitState({ [repo.path]: { kind: "branch", name: "main" } }),
      pullRequests: new FakePullRequests(),
      claudeConfig: {
        projectsDir: `${home}/claude/projects`,
        claudeJson: `${home}/claude/.claude.json`,
      },
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
    const alwaysGate = () =>
      onWorkspaceMainFlow(
        [
          agent("s1"),
          gate("g1", { settings: { stopWhen: "always", instruction: "Check" } }),
          agent("s2"),
        ],
        [thenWire("s1", "g1"), thenWire("g1", "s2")],
      );

    const branchOn = (variable: string) =>
      onWorkspaceMainFlow(
        [branch("b", variable), agent("yes"), agent("no")],
        [wire("b", "yes", "yes", "in"), wire("b", "no", "no", "in")],
      );

    it("offers the same Run choices whether or not the build has an Always Gate", async () => {
      expect(await call("run-options", { buildId: await builtId(alwaysGate()) })).toEqual({
        kind: "choices",
        variables: [],
      });
    });

    it("offers each not-defined yes/no variable with the build's value, and no text variable", async () => {
      const ticketed = onWorkspaceMainFlow(
        [
          agent("plan", { settings: { instructions: "Fix {{ticket}}." } }),
          branch("b", "deep"),
          agent("yes"),
          agent("no"),
        ],
        [thenWire("plan", "b"), wire("b", "yes", "yes", "in"), wire("b", "no", "no", "in")],
      );
      const buildId = await builtId(ticketed, { deep: true, ticket: "FD-1" });

      expect(await call("run-options", { buildId })).toEqual({
        kind: "choices",
        variables: [{ name: "deep", value: true }],
      });
    });

    it("offers no variable an Agent defines before its Branch", async () => {
      const defined = onWorkspaceMainFlow(
        [
          agent("check", {
            settings: { produces: [{ variable: "deep", yesIf: "big", noIf: "small" }] },
          }),
          branch("b", "deep"),
          agent("yes"),
          agent("no"),
        ],
        [thenWire("check", "b"), wire("b", "yes", "yes", "in"), wire("b", "no", "no", "in")],
      );

      expect(await call("run-options", { buildId: await builtId(defined) })).toEqual({
        kind: "choices",
        variables: [],
      });
    });

    it("passes an Always Gate in an automatic run, and stores the choice with the run", async () => {
      const runId = await start(alwaysGate(), { auto: true });

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "g1")).toBe("skipped");
      expect(runs.findRun(runId)?.inputs).toEqual({ auto: true });
    });

    it("stops at an Always Gate in a normal run", async () => {
      handler = handlerWith({ waits: createAppWaiter({ push: (push) => pushes.push(push) }) });

      const runId = await start(alwaysGate());

      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"));
      expect(runs.findRun(runId)?.inputs).toEqual({});
    });

    it("takes Branch's path from the build's yes/no value, ignoring Trigger flags sent with the run", async () => {
      const buildId = await builtId(branchOn("deep"), { deep: false });

      const runId = await startOn(buildId, { inputs: { ticket: "FD-1" }, flags: { deep: true } });

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "yes")).toBe("skipped");
      expect(statusOf(runId, "no")).toBe("done");
      expect(runs.findRun(runId)?.inputs).toEqual({});
    });

    it("takes the yes/no value sent with the run over the build's, stores it with the run and leaves the build's", async () => {
      const buildId = await builtId(branchOn("deep"), { deep: false });

      const runId = await startOn(buildId, { variables: { deep: true } });

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "yes")).toBe("done");
      expect(statusOf(runId, "no")).toBe("skipped");
      expect(runs.findRun(runId)?.inputs).toEqual({ variables: { deep: true } });
      const manifest = JSON.parse(
        await readFile(join(buildDirOf(buildId), "manifest.json"), "utf8"),
      ) as { values: Record<string, unknown> };
      expect(manifest.values).toEqual({ deep: false });
      expect(await call("run-options", { buildId })).toEqual({
        kind: "choices",
        variables: [{ name: "deep", value: false }],
      });
    });
  });

  describe("stop", () => {
    it("stops a run during an agent's turn and marks it stopped, writing nothing after", async () => {
      withClaude((nodeId) => (nodeId === "s1" ? "hold" : "done"));
      const runId = await start(
        onWorkspaceMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]),
      );
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

    it("ends the workspace and every session still alive, showing the started one stopped and the never-hooked one not started", async () => {
      const claude = fakeClaudeSession((nodeId) =>
        nodeId === "workspace-1-wait" ? "hold" : "done",
      );
      const stopped: string[] = [];
      handler = handlerWith({
        run: runEnvironment({
          startEvents: claude.startEvents,
          openSession: async (opening) => {
            const session = await claude.openSession(opening);
            return {
              ...session,
              stop: async () => {
                stopped.push(opening.sessionName);
              },
            };
          },
        }),
      });
      const runId = await start(
        sessionsWorkflow(
          [
            { name: "android", repo: repo.path, branch: "main" },
            { name: "ios", repo: repo.path, branch: "main" },
          ],
          { workspace: ["Wait"] },
        ),
      );
      await vi.waitFor(() => expect(claude.sentTo("workspace-1-wait")).toHaveLength(1));
      const workspace = claude.opened[0];
      const env = (workspace as (OpenSessionOptions & { env?: Record<string, string> }) | undefined)
        ?.env;
      const android = {
        tmuxName: env?.["FD_SESSION_ANDROID_TMUX"] ?? "",
        claudeSessionId: env?.["FD_SESSION_ANDROID_ID"] ?? "",
      };
      const iosTmux = env?.["FD_SESSION_IOS_TMUX"] ?? "";
      alive.add(android.tmuxName);
      alive.add(iosTmux);
      claude.events.publish({
        kind: "PreToolUse",
        sessionId: android.claudeSessionId,
        payload: {
          hook_event_name: "PreToolUse",
          session_id: android.claudeSessionId,
          tool_name: "Agent",
          tool_input: { subagent_type: "agent", prompt: "NODE session-1-plan\nGo" },
          tool_use_id: "toolu-session-1-plan",
        },
      });
      await vi.waitFor(() => expect(statusOf(runId, "session-1-plan")).toBe("running"));

      expect(await call("stop-run", { runId })).toEqual({ stopped: true });

      expect(runs.findRun(runId)?.status).toBe("stopped");
      expect([...stopped, ...ended]).toContain(workspace?.sessionName);
      expect(ended).toContain(android.tmuxName);
      expect(alive.has(android.tmuxName)).toBe(false);
      expect(iosTmux).toMatch(/^fd-/);
      expect(ended).toContain(iosTmux);
      expect(alive.has(iosTmux)).toBe(false);
      const groups = (await call("run-pipeline", { runId })) as PipelineGroup[];
      expect(groups.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: "workspace", status: "stopped" },
        { name: "android", status: "stopped" },
        { name: "ios", status: "not-started" },
      ]);
    });

    it("shows a session still waiting on its start dialogs stopped, not failed, when the user stops the run", async () => {
      const claude = fakeClaudeSession((nodeId) =>
        nodeId === "workspace-1-wait" ? "hold" : "done",
      );
      const waitingDialogs = new Map<string, (error: Error) => void>();
      handler = handlerWith({
        run: runEnvironment({ startEvents: claude.startEvents, openSession: claude.openSession }),
        answerDialogs: (name) =>
          new Promise<void>((_, reject) => {
            waitingDialogs.set(name, reject);
          }),
        endSession: async (name) => {
          ended.push(name);
          alive.delete(name);
          waitingDialogs.get(name)?.(new Error(`Session "${name}" does not exist`));
        },
      });
      const runId = await start(
        sessionsWorkflow([{ name: "android", repo: repo.path, branch: "main" }], {
          workspace: ["Wait"],
        }),
      );
      await vi.waitFor(() => expect(claude.sentTo("workspace-1-wait")).toHaveLength(1));
      const env = (
        claude.opened[0] as (OpenSessionOptions & { env?: Record<string, string> }) | undefined
      )?.env;
      const android = {
        tmuxName: env?.["FD_SESSION_ANDROID_TMUX"] ?? "",
        claudeSessionId: env?.["FD_SESSION_ANDROID_ID"] ?? "",
      };
      alive.add(android.tmuxName);
      claude.events.publish({
        kind: "PreToolUse",
        sessionId: android.claudeSessionId,
        payload: {
          hook_event_name: "PreToolUse",
          session_id: android.claudeSessionId,
          tool_name: "Agent",
          tool_input: { subagent_type: "agent", prompt: "NODE session-1-plan\nGo" },
          tool_use_id: "toolu-session-1-plan",
        },
      });
      await vi.waitFor(() => expect(waitingDialogs.has(android.tmuxName)).toBe(true), {
        timeout: 5000,
      });

      expect(await call("stop-run", { runId })).toEqual({ stopped: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ended).toContain(android.tmuxName);
      expect(runs.events(runId).filter((event) => event.kind === "failed")).toEqual([]);
      const groups = (await call("run-pipeline", { runId })) as PipelineGroup[];
      expect(groups.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: "workspace", status: "stopped" },
        { name: "android", status: "stopped" },
      ]);
    });

    it("answers not stopped for a run it does not know", async () => {
      expect(await call("stop-run", { runId: "nope" })).toEqual({ stopped: false });
    });

    describe("on a run left interrupted", () => {
      const interrupted = async (tmuxName: string) => {
        const buildId = await builtId(onWorkspaceMainFlow([agent("s1")], []));
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

      it("ends every session of the run still alive, one that never delivered a hook included", async () => {
        const buildId = await builtId(onWorkspaceMainFlow([agent("s1")], []));
        const { id: runId } = runs.createRun({
          buildDir: buildDirOf(buildId),
          inputs: {},
          nodeIds: ["s1"],
          session: { tmuxName: "fd-run-left", cwd: repo.path, claudeSessionId: "c-left" },
          sessions: [
            { tmuxName: "fd-run-child", cwd: "/b/sessions/web/app", claudeSessionId: "c-child" },
          ],
          buildId,
        });
        alive.add("fd-run-child");

        expect(await call("stop-run", { runId })).toEqual({ stopped: true });

        expect(ended).toEqual(["fd-run-child"]);
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

  describe("going runs at quit", () => {
    let narrator: FakeRunNarrator;
    let stoppedSessions: string[];

    const twoAgents = () => onWorkspaceMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]);

    const holding = () => {
      const claude = fakeClaudeSession((nodeId) => (nodeId === "s1" ? "hold" : "done"));
      handler = handlerWith({
        narrator,
        run: runEnvironment({
          startEvents: claude.startEvents,
          openSession: async (opening) => {
            const session = await claude.openSession(opening);
            return {
              ...session,
              stop: async () => {
                stoppedSessions.push(opening.sessionName);
              },
            };
          },
        }),
      });
    };

    const going = async () => {
      const runId = await start(twoAgents());
      await vi.waitFor(() => expect(statusOf(runId, "s1")).toBe("sent"));
      return runId;
    };

    const leftOver = async (tmuxName: string, children: string[] = []) => {
      const buildId = await builtId(onWorkspaceMainFlow([agent("s1")], []));
      const { id } = runs.createRun({
        buildDir: buildDirOf(buildId),
        inputs: {},
        nodeIds: ["s1"],
        session: { tmuxName, cwd: repo.path, claudeSessionId: `c-${tmuxName}` },
        sessions: children.map((child) => ({
          tmuxName: child,
          cwd: "/b/sessions/web/app",
          claudeSessionId: `c-${child}`,
        })),
        buildId,
      });
      return id;
    };

    const goingIds = async () => ((await call("going-runs")) as { runIds: string[] }).runIds;

    beforeEach(() => {
      narrator = new FakeRunNarrator({ text: "Told.", cost: 0.25 });
      stoppedSessions = [];
    });

    it("lists a run it is driving", async () => {
      holding();
      const runId = await going();

      expect(await goingIds()).toEqual([runId]);
    });

    it("lists a run left running whose session is still alive", async () => {
      const runId = await leftOver("fd-run-left");
      alive.add("fd-run-left");

      expect(await goingIds()).toEqual([runId]);
    });

    it("leaves out a run left running whose session has ended, and runs that have stopped or finished, and lists a driven run once", async () => {
      holding();
      const drivenId = await going();
      const driven = runs.findRun(drivenId);
      if (driven !== undefined) alive.add(driven.session.tmuxName);
      await leftOver("fd-run-gone");
      const stoppedId = await leftOver("fd-run-stopped");
      alive.add("fd-run-stopped");
      runs.stopRun(stoppedId);
      const doneId = await startOn(await builtId(onWorkspaceMainFlow([agent("s9")], [])));
      expect(await finished(doneId)).toBe("done");

      expect(await goingIds()).toEqual([drivenId]);
    });

    it("records nothing and ends no session when asked which runs are going", async () => {
      holding();
      const drivenId = await going();
      const leftId = await leftOver("fd-run-left");
      alive.add("fd-run-left");
      const before = [...runs.events(drivenId), ...runs.events(leftId)];

      await goingIds();

      expect([...runs.events(drivenId), ...runs.events(leftId)]).toEqual(before);
      expect(ended).toEqual([]);
      expect(stoppedSessions).toEqual([]);
      expect(runs.findRun(drivenId)?.status).toBe("running");
      expect(runs.findRun(leftId)?.status).toBe("running");
    });

    it("stops a driven run the way Stop does, ending its sessions, without writing its story", async () => {
      holding();
      const runId = await going();

      expect(await call("stop-going-runs")).toEqual({ runIds: [runId], pendingIds: [] });

      expect(runs.findRun(runId)?.status).toBe("stopped");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs.events(runId).map(({ nodeId, kind }) => `${nodeId} ${kind}`)).toEqual([
        "start running",
        "start done",
        "s1 sent",
      ]);
      expect(stoppedSessions.every((name) => name.startsWith("fd-"))).toBe(true);
      expect(stoppedSessions).not.toEqual([]);
      expect(narrator.calls).toEqual([]);
      expect(pushes).not.toContainEqual({ push: "story", runId });
    });

    it("stops a run left running with a live session, ending each of its live sessions", async () => {
      const runId = await leftOver("fd-run-left", ["fd-run-child"]);
      alive.add("fd-run-left");
      alive.add("fd-run-child");

      expect(await call("stop-going-runs")).toEqual({ runIds: [runId], pendingIds: [] });

      expect(runs.findRun(runId)?.status).toBe("stopped");
      expect(ended).toEqual(["fd-run-left", "fd-run-child"]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(narrator.calls).toEqual([]);
    });

    it("answers once every going run is stopped, naming them all, and leaves a run that is not going alone", async () => {
      holding();
      const first = await going();
      const second = await going();
      const left = await leftOver("fd-run-left");
      alive.add("fd-run-left");
      const gone = await leftOver("fd-run-gone");

      const { runIds } = (await call("stop-going-runs")) as { runIds: string[] };

      expect([...runIds].sort()).toEqual([first, second, left].sort());
      expect(runs.findRun(first)?.status).toBe("stopped");
      expect(runs.findRun(second)?.status).toBe("stopped");
      expect(runs.findRun(left)?.status).toBe("stopped");
      expect(runs.findRun(gone)?.status).toBe("running");
    });
  });

  describe("retry", () => {
    const twoAgents = () => onWorkspaceMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]);

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

      const going = await start(onWorkspaceMainFlow([agent("nap")], []));
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
        onWorkspaceMainFlow(
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
      onWorkspaceMainFlow(
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

    it("keeps the run's own yes/no value on resume", async () => {
      let s1Turns = 0;
      withClaude((nodeId) => (nodeId === "s1" && ++s1Turns === 1 ? "hold" : "done"));
      const buildId = await builtId(
        onWorkspaceMainFlow(
          [agent("s1"), branch("b", "deep"), agent("yes"), agent("no")],
          [thenWire("s1", "b"), wire("b", "yes", "yes", "in"), wire("b", "no", "no", "in")],
        ),
        { deep: false },
      );
      const runId = await startOn(buildId, { variables: { deep: true } });
      await vi.waitFor(() => expect(statusOf(runId, "s1")).toBe("sent"));
      await call("stop-run", { runId });

      expect(started(await call("resume-run", { runId }))).toBe(runId);

      expect(await finished(runId)).toBe("done");
      expect(statusOf(runId, "yes")).toBe("done");
      expect(statusOf(runId, "no")).toBe("skipped");
    });

    it("refuses a stopped run while another run of its build is going, leaving it stopped", async () => {
      withClaude(() => "hold");
      const buildId = await builtId(onWorkspaceMainFlow([agent("s1")], []));
      const first = await startOn(buildId);
      await vi.waitFor(() => expect(statusOf(first, "s1")).toBe("sent"));
      await call("stop-run", { runId: first });
      const second = await startOn(buildId);

      expect(await call("resume-run", { runId: first })).toMatchObject({ kind: "error" });

      expect(runs.findRun(first)?.status).toBe("stopped");
      expect(runs.findRun(second)?.status).toBe("running");
    });

    it("refuses a run that is done", async () => {
      const runId = await start(onWorkspaceMainFlow([agent("s1")], []));
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
      const runId = await start(onWorkspaceMainFlow([agent("p1")], []));
      await vi.waitFor(() => expect(statusOf(runId, "p1")).toBe("sent"));
      await call("stop-run", { runId });

      expect(started(await call("resume-run", { runId }))).toBe(runId);

      expect(opened.at(-1)).toMatchObject({ resume: true });
      expect(opened.at(-1)?.attach).toBeUndefined();
      await call("stop-run", { runId });
    });

    it("ends the run failed with the cut-off message when the step's turn never ended in the gone session", async () => {
      const prompts: string[] = [];
      const logged = vi.spyOn(console, "log");
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      handler = handlerWith({
        run: runEnvironment({
          openSession: async (options) => {
            if (options.attach === true) throw new SessionGoneError(options.sessionName);
            return {
              sessionId: options.claudeSessionId,
              session: { ensureStarted: async () => undefined },
              prompts: {
                sendPrompt: async (text) => {
                  prompts.push(text);
                },
                interrupt: async () => undefined,
              },
              stop: async () => undefined,
            };
          },
        }),
        sessionAlive: async () => false,
        transcriptTurns: async () => prompts.map((userText) => ({ userText, ended: false })),
      });
      const runId = await start(onWorkspaceMainFlow([agent("p1")], []));
      await vi.waitFor(() => expect(statusOf(runId, "p1")).toBe("sent"));
      await call("stop-run", { runId });

      expect(started(await call("resume-run", { runId }))).toBe(runId);

      expect(await finished(runId)).toBe("failed");
      const p1 = runs.events(runId).filter((event) => event.nodeId === "p1");
      expect(p1.at(-1)).toMatchObject({
        kind: "failed",
        payload: { message: cutOffMessage("p1") },
      });
      expect(p1.filter((event) => event.kind === "sent")).toHaveLength(1);
      expect(prompts).toHaveLength(1);
      expect(logged).not.toHaveBeenCalledWith(expect.stringContaining("Illegal node state move"));
    });

    it("refuses, changing nothing, when the session ends between the check and the attach", async () => {
      const opened: OpenSessionOptions[] = [];
      handler = handlerWith({ run: recordingSessions(opened), sessionAlive: async () => true });
      const runId = await start(onWorkspaceMainFlow([agent("p1")], []));
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
      const runId = await start(onWorkspaceMainFlow([agent("s1")], []));
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
        expect.objectContaining({ nodeId: "session-1-start", tokens: 0, cost: 0 }),
        expect.objectContaining({ nodeId: "session-1-stop", tokens: 0, cost: 0 }),
      ]);
      expect(report.total).toMatchObject({ tokens: 7, cost: 0.25 });
    });
  });
});
