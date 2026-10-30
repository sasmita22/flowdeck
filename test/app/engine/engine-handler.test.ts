import { execFile } from "node:child_process";
import { appendFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";
import {
  createEngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import { createAppWaiter } from "../../../src/app/engine/app-waiter.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import type { OpenSessionOptions, OpenedSession } from "../../../src/core/run/execute.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import {
  flow,
  gate,
  loop,
  prompt,
  script,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

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
    worktree: new FakeWorktree(),
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

    it("refuses a working folder path that is not a folder", async () => {
      const missing = join(repo.path, "missing");
      flows.save(inFolder(twoScripts(), { kind: "path", path: missing }));

      await expectErrorAndNoRun(`Working folder not found: ${missing}`);
    });

    describe("with a fresh worktree folder", () => {
      let source: TmpRepo;

      const promptAt = (workingFolder: Flow["session"]["workingFolder"]) =>
        inFolder(
          flow([trigger("start"), prompt("plan")], [thenWire("start", "plan")]),
          workingFolder,
        );

      const seenAtOpen = async (opening: OpenSessionOptions) => ({
        cwd: opening.cwd,
        id8: opening.claudeSessionId.slice(0, 8),
        worktrees: await worktreePaths(source.path),
        branches: await branches(source.path),
      });

      const withRealWorktree = (seen: Awaited<ReturnType<typeof seenAtOpen>>[]) =>
        handlerWith({
          worktree: new GitWorktree(),
          run: {
            ...runEnvironment(new NodeFileSystem()),
            openSession: async (opening) => {
              seen.push(await seenAtOpen(opening));
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

      it("creates the worktree and its branch before node 1 and runs the session inside it", async () => {
        const seen: Awaited<ReturnType<typeof seenAtOpen>>[] = [];
        handler = withRealWorktree(seen);
        flows.save(promptAt({ kind: "worktree", repo: source.path, branch: "main" }));

        const runId = await startedRunId();
        await untilFinished(runId);

        const [atOpen] = seen;
        if (atOpen === undefined) throw new Error("Claude never started");
        const path = join(home, "worktrees", atOpen.id8);
        expect(atOpen.worktrees).toContain(await realpath(path));
        expect(atOpen.branches).toContain(`flowdeck/${atOpen.id8}`);
        expect(atOpen.cwd).toBe(path);
        expect(runs.findRun(runId)?.session.cwd).toBe(path);
        expect((await git(path, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
          `flowdeck/${atOpen.id8}`,
        );
      });

      it("gives two runs of the same flow their own branch and folder", async () => {
        const seen: Awaited<ReturnType<typeof seenAtOpen>>[] = [];
        handler = withRealWorktree(seen);
        flows.save(promptAt({ kind: "worktree", repo: source.path, branch: "main" }));

        await untilFinished(await startedRunId());
        await untilFinished(await startedRunId());

        const cwds = runs.runs.map((run) => run.session.cwd);
        expect(cwds).toHaveLength(2);
        expect(new Set(cwds).size).toBe(2);
        expect(await worktreePaths(source.path)).toHaveLength(3);
        expect((await branches(source.path)).match(/^flowdeck\//gm)).toHaveLength(2);
      });

      it("writes nothing from the run back into the saved flow", async () => {
        handler = withRealWorktree([]);
        const saved = promptAt({ kind: "worktree", repo: source.path, branch: "main" });
        flows.save(saved);

        await untilFinished(await startedRunId());

        expect(flows.loadLatest()?.flow).toEqual(saved);
      });

      it("creates no worktree or branch for an existing folder, and runs in that folder", async () => {
        const worktree = new FakeWorktree();
        handler = handlerWith({ worktree });
        flows.save(inFolder(twoScripts(), { kind: "path", path: source.path }));
        const worktreesBefore = await worktreePaths(source.path);
        const branchesBefore = await branches(source.path);

        const runId = await startedRunId();
        await untilFinished(runId);

        expect(worktree.calls).toEqual([]);
        expect(await worktreePaths(source.path)).toEqual(worktreesBefore);
        expect(await branches(source.path)).toBe(branchesBefore);
        expect(runs.findRun(runId)?.session.cwd).toBe(source.path);
        expect(await stat(join(home, "worktrees")).catch(() => undefined)).toBeUndefined();
      });

      it.each<[string, Flow["session"]["workingFolder"]]>([
        ["no repo", { kind: "worktree", branch: "main" }],
        ["an empty repo", { kind: "worktree", branch: "main", repo: "" }],
      ])(
        "refuses a worktree folder with %s and never calls the worktree port",
        async (_, folder) => {
          const worktree = new FakeWorktree();
          handler = handlerWith({ worktree });
          flows.save(inFolder(twoScripts(), folder));

          await expectErrorAndNoRun(/repositor/i);
          expect(worktree.calls).toEqual([]);
        },
      );

      it("returns the worktree port's failure and creates no run", async () => {
        const worktree = new FakeWorktree({ failWith: "git worktree add exploded" });
        handler = handlerWith({ worktree });
        flows.save(inFolder(twoScripts(), { kind: "worktree", repo: source.path, branch: "main" }));

        await expectErrorAndNoRun(/git worktree add exploded/);
        expect(worktree.calls).toHaveLength(1);
      });
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
        flow(
          [
            script("s1", { settings: { command: "echo", args: ["one"] } }),
            gate("g1"),
            script("s2", { settings: { command: "echo", args: ["two"] } }),
          ],
          [thenWire("s1", "g1"), thenWire("g1", "s2")],
        ),
      );

    const withAppWaiter = () => {
      const waiter = createAppWaiter({ push: collectInto(pushes) });
      return handlerWith({
        run: { ...runEnvironment(new NodeFileSystem()), waiter },
        waits: waiter,
      });
    };

    const waitPushes = () => pushes.flatMap((push) => (push.push === "wait" ? [push.value] : []));

    const openedWaitId = async (nodeId: string) => {
      await vi.waitFor(() => {
        expect(waitPushes().at(-1)?.request.nodeId).toBe(nodeId);
      });
      const opened = waitPushes().at(-1);
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
        nodes: { s1: "done", g1: "needs-you", s2: "waiting" },
      });
    };

    it("resumes a run parked at a gate when the open wait is approved", async () => {
      handler = withAppWaiter();
      flows.save(gated());
      const runId = await startedRunId();
      const waitId = await openedWaitId("g1");

      expect(await answerWait({ waitId, reply: { decision: "approve" } })).toEqual({
        id: nextId - 1,
        ok: true,
        value: { accepted: true },
      });

      await untilFinished(runId);
      expect(snapshotsOf(runId).at(-1)).toEqual({
        runId,
        status: "done",
        nodes: { s1: "done", g1: "done", s2: "done" },
      });
      expect(runs.events(runId)).toContainEqual(
        expect.objectContaining({
          nodeId: "g1",
          kind: "decided",
          payload: { nodeId: "g1", decision: "approved" },
        }),
      );
    });

    it.each([
      ["a closed decision", (waitId: string) => ({ waitId, reply: { decision: "closed" } })],
      ["a malformed payload", (waitId: string) => ({ waitId, reply: "approve" })],
      ["a payload without a wait id", () => ({ reply: { decision: "approve" } })],
    ])("refuses %s and leaves the run parked at the gate", async (_name, payloadFor) => {
      handler = withAppWaiter();
      flows.save(gated());
      const runId = await startedRunId();
      const waitId = await openedWaitId("g1");

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
      const waitId = await openedWaitId("g1");

      expect(await answerWait({ waitId: `${waitId}-old`, reply: { decision: "approve" } })).toEqual(
        { id: nextId - 1, ok: true, value: { accepted: false } },
      );

      await parkedAtGate(runId);
    });

    it("drops the open wait when the run is stopped, and a late answer adds no events", async () => {
      handler = withAppWaiter();
      flows.save(gated());
      const runId = await startedRunId();
      const waitId = await openedWaitId("g1");

      await handler.stop();

      expect(waitPushes().at(-1)).toBeNull();
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
