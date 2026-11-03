import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";
import { createAppWaiter, type AppWaiter } from "../../../src/app/engine/app-waiter.js";
import {
  createEngineHandler,
  type EngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import type { OpenSessionOptions, OpenedSession } from "../../../src/core/run/execute.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import type { PendingWait } from "../../../src/core/run/wait.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import { flow, gate, prompt, script, thenWire } from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const isFolder = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const sh = (id: string, command: string) =>
  script(id, { settings: { command: "sh", args: ["-c", command] } });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("an app restart", () => {
  let home: string;
  let repo: TmpRepo;
  let runs: FakeStore;
  let flows: FakeFlowStore;
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
      sendPrompt: async () => {
        sending.started++;
        await sending.held;
        setTimeout(
          () => events.publish({ kind: "Stop", sessionId: options.claudeSessionId, payload: {} }),
          0,
        );
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
      }),
      isFolder,
      fs: new NodeFileSystem(),
      connectors: new FakeConnectorSource(),
      run: {
        fs: new NodeFileSystem(),
        now: Date.now,
        scripts: new NodeProcessRunner(),
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
    const { flowId, version } = flows.save({
      ...input,
      session: { ...input.session, buildConfig: { repo: repo.path, variables: [] } },
    });
    const built = (await call(handler, "build-version", {
      flowId,
      version,
      name: `build-${++names}`,
      values: {},
    })) as { id: string };
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
    pushes.findLast((push) => push.push === "wait" && push.runId === runId)?.value as
      PendingWait | null | undefined;
  const cwdOf = (runId: string) => {
    const cwd = runs.findRun(runId)?.session.cwd;
    if (cwd === undefined || cwd === "") throw new Error(`run ${runId} has no folder`);
    return cwd;
  };
  const sessionName = (runId: string) => runs.findRun(runId)?.session.tmuxName ?? "";

  const askedAtGate = () =>
    flow(
      [prompt("p1"), gate("g1", { settings: { shown: "Check the plan" } }), sh("s2", "true")],
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
      await start(first, flow([prompt("p1")], []));
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
      await start(first, flow([prompt("p1")], []));
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

    it("leaves a running script running", async () => {
      const first = newHandler();
      const runId = await start(first, flow([sh("s1", "echo $$ > s1.pid; exec sleep 30")], []));
      const pidText = () => readFile(join(cwdOf(runId), "s1.pid"), "utf8").catch(() => "");
      await vi.waitFor(async () => expect(await pidText()).toMatch(/^\d+\n$/));

      await first.detach();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const pid = Number(await pidText());
      expect(isAlive(pid)).toBe(true);
      expect(runs.findRun(runId)?.status).toBe("running");
      process.kill(pid, "SIGKILL");
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

    it("rejoins a script that kept running while the app was closed, without running it again", async () => {
      const first = newHandler();
      const runId = await start(
        first,
        flow(
          [
            sh(
              "s1",
              "echo once >> s1.log; n=0; while [ ! -f go ] && [ $n -lt 300 ]; do sleep 0.05; n=$((n+1)); done",
            ),
            sh("s2", "true"),
          ],
          [thenWire("s1", "s2")],
        ),
      );
      await vi.waitFor(async () =>
        expect(await readFile(join(cwdOf(runId), "s1.log"), "utf8").catch(() => "")).toBe("once\n"),
      );
      await first.detach();

      const second = newHandler();
      await second.reattach();
      await writeFile(join(cwdOf(runId), "go"), "");

      await vi.waitFor(() => expect(runs.findRun(runId)?.status).toBe("done"), { timeout: 5000 });
      expect(await readFile(join(cwdOf(runId), "s1.log"), "utf8")).toBe("once\n");
      expect(kindsOf(runId, "s1")).toEqual(["running", "done"]);
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
        flow(
          [prompt("p1"), gate("g1"), prompt("p2")],
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
});
