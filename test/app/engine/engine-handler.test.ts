import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";
import {
  createEngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import type { OpenedSession } from "../../../src/core/run/execute.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { flow, loop, prompt, script, thenWire, trigger } from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const stores = (flows = new FakeFlowStore()) => ({ runs: new FakeStore(), flows });

const savedFlow = () => flow([trigger("start"), prompt("plan")], [thenWire("start", "plan")]);

const failingOpen = () => {
  throw new Error("boom");
};

const isFolder = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const runEnvironment = (fs: NodeFileSystem, now: () => number = Date.now) => ({
  fs,
  now,
  scripts: new NodeProcessRunner(),
  waiter: new FakeWaiter([]),
  startEvents: async () => ({ events: new FakeEventSource(), stop: async () => undefined }),
  openSession: async () => {
    throw new Error("Claude must not start for a script-only flow");
  },
});

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
    }),
    isFolder,
    fs,
    run: runEnvironment(fs),
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

  it("opens the stores once across status, save and load requests", async () => {
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
    await handler.handle({ id: 2, type: "save-flow", payload: savedFlow() });
    await handler.handle({ id: 3, type: "load-latest-flow" });
    await handler.handle({ id: 4, type: "save-flow", payload: savedFlow() });

    expect(opens).toBe(1);
  });

  it("saves a valid flow payload as version 1 and keeps it in the flow store", async () => {
    const flows = new FakeFlowStore({ newId: () => "flow-a" });
    const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

    expect(await handler.handle({ id: 5, type: "save-flow", payload: savedFlow() })).toEqual({
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

    await handler.handle({ id: 1, type: "save-flow", payload: savedFlow() });

    expect(await handler.handle({ id: 2, type: "save-flow", payload: savedFlow() })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "saved", flowId: "flow-a", version: 2 },
    });
  });

  it("returns an error result and saves nothing when the payload is not a flow", async () => {
    const flows = new FakeFlowStore();
    const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

    expect(await handler.handle({ id: 3, type: "save-flow", payload: { nodes: "nope" } })).toEqual({
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

    expect(await handler.handle({ id: 4, type: "save-flow", payload: savedFlow() })).toEqual({
      id: 4,
      ok: true,
      value: { kind: "error", message: "disk full" },
    });
    expect(flows.loadLatest()).toBeNull();
  });

  it("loads empty before any save", async () => {
    const handler = createEngineHandler(options({ openStores: () => stores() }));

    expect(await handler.handle({ id: 6, type: "load-latest-flow" })).toEqual({
      id: 6,
      ok: true,
      value: { kind: "empty" },
    });
  });

  it("loads the saved flow after a save", async () => {
    const handler = createEngineHandler(options({ openStores: () => stores() }));

    await handler.handle({ id: 1, type: "save-flow", payload: savedFlow() });

    expect(await handler.handle({ id: 2, type: "load-latest-flow" })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "loaded", flow: savedFlow() },
    });
  });

  it("returns the store's error as an error result when the load throws", async () => {
    const flows = new FakeFlowStore();
    flows.loadLatest = () => {
      throw new Error("database is locked");
    };
    const handler = createEngineHandler(options({ openStores: () => stores(flows) }));

    expect(await handler.handle({ id: 7, type: "load-latest-flow" })).toEqual({
      id: 7,
      ok: true,
      value: { kind: "error", message: "database is locked" },
    });
  });

  it("returns error results for save and load when the stores fail to open", async () => {
    const handler = createEngineHandler(options({ openStores: failingOpen }));

    expect(await handler.handle({ id: 1, type: "save-flow", payload: savedFlow() })).toEqual({
      id: 1,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
    expect(await handler.handle({ id: 2, type: "load-latest-flow" })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
    expect(await handler.handle({ id: 3, type: "store-status" })).toEqual({
      id: 3,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
  });

  describe("start-run", () => {
    let home: string;
    let repo: TmpRepo;
    let runs: FakeStore;
    let flows: FakeFlowStore;
    let pushes: EnginePush[];
    let handler: ReturnType<typeof createEngineHandler>;
    let nextId: number;

    const inFolder = (input: Flow, workingFolder: Flow["session"]["workingFolder"]): Flow => ({
      ...input,
      session: { ...input.session, workingFolder },
    });

    const atRepo = (input: Flow): Flow => inFolder(input, { kind: "path", path: repo.path });

    const twoScripts = () =>
      atRepo(
        flow(
          [
            script("write", {
              settings: { command: "sh", args: ["-c", "echo ran > side-effect.txt"] },
            }),
            script("check", { settings: { command: "test", args: ["-f", "side-effect.txt"] } }),
          ],
          [thenWire("write", "check")],
        ),
      );

    const sleeper = () =>
      atRepo(flow([script("nap", { settings: { command: "sleep", args: ["3"] } })], []));

    const handlerWith = (overrides: Partial<EngineHandlerOptions> = {}) =>
      createEngineHandler(
        options({
          openStores: () => ({ runs, flows }),
          home,
          publish: (push) => pushes.push(push),
          prepareHooks: () => ({
            kind: "ok",
            nodePath: process.execPath,
            hookScriptPath: `${home}/hooks/flowdeck-hook.cjs`,
          }),
          ...overrides,
        }),
      );

    const startRun = async () => {
      const response = await handler.handle({ id: nextId, type: "start-run" });
      expect(response).toMatchObject({ id: nextId++, ok: true });
      return (response as { value: unknown }).value as
        { kind: "started"; runId: string } | { kind: "error"; message: string };
    };

    const startedRunId = async () => {
      const result = await startRun();
      if (result.kind !== "started") throw new Error(`run did not start: ${result.message}`);
      return result.runId;
    };

    const snapshotsOf = (runId: string) =>
      pushes.flatMap((push) =>
        push.push === "run-state" && push.value.runId === runId ? [push.value] : [],
      );

    const sessionPushes = () => pushes.filter((push) => push.push === "session");

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
      expect(result).toEqual({
        kind: "error",
        message: typeof message === "string" ? message : expect.stringMatching(message),
      });
      expect(runs.runs).toEqual([]);
    };

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "fd-home-"));
      repo = await createTmpRepo();
      runs = new FakeStore();
      flows = new FakeFlowStore();
      pushes = [];
      nextId = 1;
      handler = handlerWith();
    });

    afterEach(async () => {
      await handler.stop();
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    });

    it("reuses one build for two runs of an unchanged flow, and points both runs at it", async () => {
      flows.save(twoScripts());

      const first = await startedRunId();
      await untilFinished(first);
      const second = await startedRunId();
      await untilFinished(second);

      const builds = runs.builds();
      expect(builds).toHaveLength(1);
      expect(runs.runs.map((run) => [run.id, run.buildHash])).toEqual([
        [first, builds[0]?.hash],
        [second, builds[0]?.hash],
      ]);
    });

    it("builds from the latest saved version", async () => {
      flows.save(twoScripts());
      const first = await startedRunId();
      await untilFinished(first);
      const v2 = twoScripts();
      flows.save({ ...v2, nodes: v2.nodes.filter((node) => node.id === "write"), wires: [] });

      const second = await startedRunId();
      await untilFinished(second);

      expect(runs.builds()).toHaveLength(2);
      expect(runs.findRun(second)?.nodeIds).toEqual(["write"]);
      expect(Object.keys(snapshotsOf(second).at(-1)?.nodes ?? {})).toEqual(["write"]);
    });

    it("publishes every node waiting first, and every node done when the run ends", async () => {
      flows.save(twoScripts());

      const runId = await startedRunId();

      expect(pushes[0]).toEqual({
        push: "run-state",
        value: { runId, status: "running", nodes: { write: "waiting", check: "waiting" } },
      });
      await untilFinished(runId);
      expect(snapshotsOf(runId).at(-1)).toEqual({
        runId,
        status: "done",
        nodes: { write: "done", check: "done" },
      });
      expect(runs.findRun(runId)?.status).toBe("done");
    });

    it("refuses a second run while one is active and creates no run for it", async () => {
      flows.save(sleeper());
      await startedRunId();

      expect(await startRun()).toEqual({
        kind: "error",
        message: "A run is already in progress",
      });
      expect(runs.runs).toHaveLength(1);
    });

    it("refuses to run when nothing is saved", async () => {
      await expectErrorAndNoRun("Save the flow before running it");
    });

    it("refuses a worktree working folder", async () => {
      flows.save(inFolder(twoScripts(), { kind: "worktree", branch: "main" }));

      await expectErrorAndNoRun(
        "Set a working folder before running (worktree folders are not supported yet)",
      );
    });

    it("refuses a working folder path that is not a folder", async () => {
      const missing = join(repo.path, "missing");
      flows.save(inFolder(twoScripts(), { kind: "path", path: missing }));

      await expectErrorAndNoRun(`Working folder not found: ${missing}`);
    });

    it("returns the hook preparation error", async () => {
      handler = handlerWith({
        prepareHooks: () => ({ kind: "error", message: "No executable node on PATH" }),
      });
      flows.save(twoScripts());

      await expectErrorAndNoRun("No executable node on PATH");
    });

    it("returns the validation problems of a flow that does not build", async () => {
      flows.save(atRepo(flow([loop("retry", { settings: { cap: 0, onCap: "fail" } })], [])));

      await expectErrorAndNoRun(/loop-cap: /);
      expect(runs.builds()).toEqual([]);
    });

    it("refuses a cached build that changed on disk since its first run", async () => {
      flows.save(twoScripts());
      const first = await startedRunId();
      await untilFinished(first);
      const [cached] = runs.builds();
      await appendFile(join(cached?.dir ?? "", "settings.json"), "\n");

      const result = await startRun();

      expect(result).toEqual({
        kind: "error",
        message: expect.stringContaining("settings.json: changed"),
      });
      expect(runs.runs.map((run) => run.id)).toEqual([first]);
    });

    it("returns the open error when the stores fail to open", async () => {
      handler = handlerWith({ openStores: failingOpen });

      expect(await startRun()).toEqual({ kind: "error", message: "boom" });
    });

    it("stops an active run, resolving once it is recorded stopped", async () => {
      flows.save(sleeper());
      const runId = await startedRunId();
      await vi.waitFor(() => {
        expect(snapshotsOf(runId).at(-1)?.nodes["nap"]).toBe("running");
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

    it("accepts only one of two start-runs sent together, and creates one run", async () => {
      flows.save(sleeper());

      const responses = await Promise.all([
        handler.handle({ id: 1, type: "start-run" }),
        handler.handle({ id: 2, type: "start-run" }),
      ]);

      const values = responses.map((response) => (response as { value: { kind: string } }).value);
      expect(values.filter((value) => value.kind === "started")).toHaveLength(1);
      expect(values.filter((value) => value.kind === "error")).toEqual([
        { kind: "error", message: "A run is already in progress" },
      ]);
      expect(runs.runs).toHaveLength(1);
    });

    it("stops a run whose start is still in progress once it has started", async () => {
      flows.save(sleeper());

      const starting = handler.handle({ id: 1, type: "start-run" });
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

    it("records the run failed when execution rejects, and accepts a later run", async () => {
      handler = withStartEvents(failingStartEvents);
      flows.save(twoScripts());
      const runId = await startedRunId();

      await vi.waitFor(() => {
        expect(runs.findRun(runId)?.status).toBe("failed");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(snapshotsOf(runId).at(-1)?.status).toBe("failed");
      expect((await startRun()).kind).toBe("started");
    });

    it("frees the run slot and resolves stop when recording a failed run throws", async () => {
      handler = withStartEvents(failingStartEvents);
      runs.finishRun = () => {
        throw new Error("database is locked");
      };
      flows.save(twoScripts());
      await startedRunId();

      await vi.waitFor(async () => {
        expect((await startRun()).kind).toBe("started");
      });

      await expect(handler.stop()).resolves.toBeUndefined();
    });

    const promptFlow = () =>
      atRepo(flow([trigger("start"), prompt("plan")], [thenWire("start", "plan")]));

    const claudeSession = (ensureStarted: () => Promise<void>): OpenedSession => ({
      sessionId: "claude-session-1",
      session: { ensureStarted },
      prompts: { sendPrompt: async () => undefined },
      stop: async () => undefined,
    });

    const withClaude = (opened: OpenedSession) =>
      handlerWith({
        newSessionName: () => "fd-run-test",
        run: { ...runEnvironment(new NodeFileSystem()), openSession: async () => opened },
      });

    it("announces the session name once Claude starts, and null when the run stops", async () => {
      handler = withClaude(claudeSession(async () => undefined));
      flows.save(promptFlow());
      await startedRunId();

      await vi.waitFor(() => {
        expect(sessionPushes()).toEqual([{ push: "session", value: "fd-run-test" }]);
      });

      await handler.stop();

      expect(sessionPushes()).toEqual([
        { push: "session", value: "fd-run-test" },
        { push: "session", value: null },
      ]);
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
      await startedRunId();

      await vi.waitFor(() => {
        expect(starting).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionPushes()).toEqual([]);

      started();

      await vi.waitFor(() => {
        expect(sessionPushes()).toEqual([{ push: "session", value: "fd-run-test" }]);
      });
    });

    it("announces no session for a script-only run", async () => {
      flows.save(twoScripts());

      const runId = await startedRunId();
      await untilFinished(runId);

      expect(sessionPushes()).toEqual([]);
    });

    const startActivityRun = async () => {
      let clock = 1000;
      const source = new FakeEventSource();
      let claudeSessionId = "";
      const hook = (kind: "PreToolUse" | "Stop", sessionId: string, at: number) =>
        source.publish({
          kind,
          sessionId,
          payload: {
            hook_event_name: kind,
            session_id: sessionId,
            flowdeck_hook_at: at,
            ...(kind === "PreToolUse"
              ? { tool_name: "Bash", tool_input: { command: "ls" } }
              : { last_assistant_message: "OK" }),
          },
        });
      handler = handlerWith({
        newSessionName: () => "fd-run-test",
        run: {
          ...runEnvironment(new NodeFileSystem(), () => clock),
          startEvents: async () => ({ events: source, stop: async () => undefined }),
          openSession: async (opening) => {
            claudeSessionId = opening.claudeSessionId;
            return {
              sessionId: claudeSessionId,
              session: { ensureStarted: async () => undefined },
              prompts: {
                sendPrompt: async () => {
                  clock = 1500;
                  hook("PreToolUse", claudeSessionId, 1200);
                  hook("PreToolUse", "another-session", 1300);
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
      ]);
    });

    it("pushes no activity for a tool call that arrives after the run has finished", async () => {
      const { claudeSessionId, hook } = await startActivityRun();

      hook("PreToolUse", claudeSessionId, 1200);

      expect(activityPushes()).toHaveLength(1);
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
        flows.save(twoScripts());
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
