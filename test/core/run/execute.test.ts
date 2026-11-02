import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";
import { build } from "../../../src/core/compiler/build.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { hashBuild } from "../../../src/core/compiler/hash.js";
import { lower, type Manifest } from "../../../src/core/compiler/lower.js";
import { parseFlow } from "../../../src/core/flow/schema.js";
import {
  execute,
  type LoadedBuild,
  loadBuild,
  needsClaude,
  noClaude,
  runSocketPath,
} from "../../../src/core/run/execute.js";
import type { ScriptResult } from "../../../src/core/run/runner.js";
import type { PermissionDecision } from "../../../src/ports/permission-source.js";
import type { UsageEntry } from "../../../src/ports/usage-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakeProcessRunner } from "../../fakes/fake-process-runner.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeUsageSource } from "../../fakes/fake-usage-source.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { permission as permissionWait } from "../../fixtures/waits.js";
import { flow, script, thenWire } from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const fs = new NodeFileSystem();

const scriptOnly = () =>
  flow(
    [
      script("write", {
        settings: { command: "sh", args: ["-c", "echo ran > side-effect.txt"] },
      }),
      script("check", { settings: { command: "test", args: ["-f", "side-effect.txt"] } }),
    ],
    [thenWire("write", "check")],
  );

const manifestWith = (types: string[]) =>
  ({
    nodes: types.map((type, index) => ({ id: `n${index}`, type })),
  }) as unknown as Manifest & { hash: string };

describe("the core run path", () => {
  let home: string;
  let repo: TmpRepo;
  let dir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    const result = await build(scriptOnly(), {
      fs,
      home,
    });
    if (!result.ok) throw new Error("build failed");
    dir = result.dir;
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  const loaded = async () => {
    const result = await loadBuild(dir, { fs });
    if (result.kind !== "loaded") throw new Error(`build not loaded: ${result.message}`);
    return result.build;
  };

  const startEvents = () => {
    let stops = 0;
    return {
      stops: () => stops,
      startEvents: async () => ({
        events: new FakeEventSource(),
        stop: async () => {
          stops++;
        },
      }),
    };
  };

  describe("loadBuild", () => {
    it("loads a verified build with its manifest", async () => {
      const result = await loadBuild(dir, { fs });

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(result.build.nodes.map((node) => node.id)).toEqual(["write", "check"]);
      expect(result.build.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a build with a changed file, with the message the CLI prints", async () => {
      const files = (await fs.list(dir)).filter((path) => path !== "manifest.json");
      const changed = files[0];
      if (changed === undefined) throw new Error("the build has no file besides its manifest");
      await writeFile(join(dir, changed), "tampered\n");

      expect(await loadBuild(dir, { fs })).toEqual({
        kind: "error",
        message: `${changed}: changed`,
      });
    });

    it("refuses a build whose parallel start has one branch, with the section problem", async () => {
      const broken = parseFlow(
        JSON.parse(
          await readFile(
            new URL("../../fixtures/broken/parallel-section.json", import.meta.url),
            "utf8",
          ),
        ),
      );
      const files = emit(lower(broken));
      const hash = hashBuild(files);
      const brokenDir = join(home, "builds", hash);
      for (const file of files) {
        const content =
          file.path === "manifest.json"
            ? canonicalJson({ ...(JSON.parse(file.content) as object), hash })
            : file.content;
        await fs.writeFile(join(brokenDir, file.path), content);
      }

      const result = await loadBuild(brokenDir, { fs });

      expect(result.kind).toBe("error");
      expect(result.kind === "error" ? result.message : "").toMatch(
        /^cannot run this build: .*split\b.*has 1 branches; a parallel start needs two or more\.$/,
      );
    });

    it("refuses a missing build folder", async () => {
      const result = await loadBuild(join(home, "builds", "nope"), { fs });

      expect(result.kind).toBe("error");
    });
  });

  describe("execute", () => {
    it("runs a script-only build in the repo and records it done", async () => {
      const build = await loaded();
      const store = new FakeStore();
      const events = startEvents();
      const lines: string[] = [];
      const { id } = store.createRun({
        buildDir: dir,
        inputs: {},
        nodeIds: build.nodes.map((node) => node.id),
        session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
        buildHash: build.hash,
      });

      const code = await execute(
        {
          fs,
          scripts: new NodeProcessRunner(),
          waiter: new FakeWaiter([]),
          startEvents: events.startEvents,
          openSession: async () => {
            throw new Error("Claude must not start for a script-only flow");
          },
          store,
          onChange: (line: string) => lines.push(line),
        },
        {
          store,
          runId: id,
          manifest: build,
          cwd: repo.path,
          auto: false,
          socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
          open: async () => noClaude,
        },
      );

      expect(code).toBe(0);
      expect(await readFile(join(repo.path, "side-effect.txt"), "utf8")).toBe("ran\n");
      expect(lines).toEqual(["write started", "write done", "check started", "check done"]);
      expect(events.stops()).toBe(1);
      expect(store.runs[0]?.status).toBe("done");
    });

    it("records the run stopped when interrupted while a script runs", async () => {
      const build = await loaded();
      const store = new FakeStore();
      const events = startEvents();
      let interrupt: (code: number) => void = () => undefined;
      let release: (result: ScriptResult) => void = () => undefined;
      const blocked = new Promise<ScriptResult>((resolve) => (release = resolve));
      const { id } = store.createRun({
        buildDir: dir,
        inputs: {},
        nodeIds: build.nodes.map((node) => node.id),
        session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
        buildHash: build.hash,
      });

      const code = await execute(
        {
          fs,
          scripts: {
            run: () => {
              interrupt(130);
              return blocked;
            },
          },
          waiter: new FakeWaiter([]),
          startEvents: events.startEvents,
          openSession: async () => {
            throw new Error("Claude must not start for a script-only flow");
          },
          store,
          onChange: () => undefined,
          onInterrupt: (handler: (exitCode: number) => void) => {
            interrupt = handler;
            return () => undefined;
          },
        },
        {
          store,
          runId: id,
          manifest: build,
          cwd: repo.path,
          auto: false,
          socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
          open: async () => noClaude,
        },
      );
      release({ code: 0, stdout: "", stderr: "" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(code).toBe(130);
      expect(store.runs[0]?.status).toBe("stopped");
    });
  });

  it("kills the running script on a stop, and writes nothing more to the run", async () => {
    const build = await loaded();
    const store = new FakeStore();
    let interrupt: (code: number) => void = () => undefined;
    const { id } = store.createRun({
      buildDir: dir,
      inputs: {},
      nodeIds: build.nodes.map((node) => node.id),
      session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
      buildHash: build.hash,
    });
    const pidFile = join(repo.path, "pid");
    const runner = new NodeProcessRunner();
    const started = Date.now();

    const code = await execute(
      {
        fs,
        scripts: {
          run: (_command, _args, cwd, signal) => {
            setTimeout(() => interrupt(143), 300);
            return runner.run("sh", ["-c", `echo $$ > ${pidFile}; exec sleep 30`], cwd, signal);
          },
        },
        waiter: new FakeWaiter([]),
        startEvents: startEvents().startEvents,
        openSession: async () => {
          throw new Error("Claude must not start for a script-only flow");
        },
        store,
        onChange: () => undefined,
        onInterrupt: (handler: (exitCode: number) => void) => {
          interrupt = handler;
          return () => undefined;
        },
      },
      {
        store,
        runId: id,
        manifest: build,
        cwd: repo.path,
        auto: false,
        socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
        open: async () => noClaude,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(code).toBe(143);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(store.findRun(id)?.status).toBe("stopped");
    expect(store.events(id).map(({ nodeId, kind }) => `${nodeId} ${kind}`)).toEqual([
      "write running",
    ]);
  });

  it("hands each script's output to onOutput with its node", async () => {
    const build = await loaded();
    const store = new FakeStore();
    const outputs: string[] = [];
    const { id } = store.createRun({
      buildDir: dir,
      inputs: {},
      nodeIds: build.nodes.map((node) => node.id),
      session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
      buildHash: build.hash,
    });

    await execute(
      {
        fs,
        scripts: { run: async () => ({ code: 0, stdout: "hi\n", stderr: "" }) },
        waiter: new FakeWaiter([]),
        startEvents: startEvents().startEvents,
        openSession: async () => {
          throw new Error("Claude must not start for a script-only flow");
        },
        store,
        onChange: () => undefined,
        onOutput: (nodeId, stream, text) => outputs.push(`${nodeId} ${stream} ${text}`),
      },
      {
        store,
        runId: id,
        manifest: build,
        cwd: repo.path,
        auto: false,
        socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
        open: async () => noClaude,
      },
    );

    expect(outputs).toEqual(["write stdout hi\n", "check stdout hi\n"]);
  });

  it("runs each script under a job in the run's script folder, and rejoins one there", async () => {
    const build = await loaded();
    const store = new FakeStore();
    const { id } = store.createRun({
      buildDir: dir,
      inputs: {},
      nodeIds: build.nodes.map((node) => node.id),
      session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
      buildHash: build.hash,
    });
    store.append(id, "write", { kind: "running" });
    const scripts = new FakeProcessRunner([{ code: 0, stdout: "", stderr: "" }]);
    const jobs = "/fd/runs/r1/scripts";
    const writeJob = `${jobs}/write-${store.events(id)[0]?.seq}`;
    scripts.finishes(writeJob, { code: 0, stdout: "", stderr: "" });

    const code = await execute(
      {
        fs,
        scripts,
        waiter: new FakeWaiter([]),
        startEvents: startEvents().startEvents,
        openSession: async () => {
          throw new Error("Claude must not start for a script-only flow");
        },
        store,
        onChange: () => undefined,
      },
      {
        store,
        runId: id,
        manifest: build,
        cwd: repo.path,
        auto: false,
        socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
        open: async () => noClaude,
        scriptJobs: jobs,
        actions: async () => ({ write: { kind: "wait" } }),
      },
    );

    expect(code).toBe(0);
    expect(scripts.rejoins).toEqual([writeJob]);
    expect(scripts.calls.map((call) => call.job)).toEqual([
      expect.stringMatching(new RegExp(`^${jobs}/check-\\d+$`)),
    ]);
  });

  it("still rejoins a script when a Stop hook lands while the run is read back", async () => {
    const build = await loaded();
    const store = new FakeStore();
    const { id } = store.createRun({
      buildDir: dir,
      inputs: {},
      nodeIds: build.nodes.map((node) => node.id),
      session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
      buildHash: build.hash,
    });
    store.append(id, "write", { kind: "running" });
    const scripts = new FakeProcessRunner([{ code: 0, stdout: "", stderr: "" }]);
    const jobs = "/fd/runs/r1/scripts";
    const writeJob = `${jobs}/write-${store.events(id)[0]?.seq}`;
    scripts.finishes(writeJob, { code: 0, stdout: "", stderr: "" });
    const events = new FakeEventSource();
    let reads = 0;

    const code = await execute(
      {
        fs,
        scripts,
        waiter: new FakeWaiter([]),
        startEvents: async () => ({ events, stop: async () => undefined }),
        openSession: async () => {
          throw new Error("execute opens the session through the execution");
        },
        store,
        onChange: () => undefined,
      },
      {
        store,
        runId: id,
        manifest: build,
        cwd: repo.path,
        auto: false,
        socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
        open: async () => ({ ...noClaude, sessionId: "c1" }),
        scriptJobs: jobs,
        actions: async () => {
          if (reads++ === 0) events.publish({ kind: "Stop", sessionId: "c1", payload: {} });
          return { write: { kind: "wait" } };
        },
      },
    );

    expect(code).toBe(0);
    expect(reads).toBe(2);
    expect(scripts.rejoins).toEqual([writeJob]);
    expect(scripts.calls.map((call) => call.job)).toEqual([
      expect.stringMatching(new RegExp(`^${jobs}/check-\\d+$`)),
    ]);
  });

  describe("needsClaude", () => {
    it("is true for a manifest with a prompt node", () => {
      expect(needsClaude(manifestWith(["script", "prompt"]))).toBe(true);
    });

    it("is false for scripts only", () => {
      expect(needsClaude(manifestWith(["script", "script"]))).toBe(false);
    });

    it("is true for a hard stop with a condition to check, and false for one without", () => {
      const withCondition = (condition: string) =>
        ({
          nodes: [{ id: "h", type: "hardstop", settings: { condition } }],
        }) as unknown as Manifest & { hash: string };

      expect(needsClaude(withCondition("tests fail"))).toBe(true);
      expect(needsClaude(withCondition(" "))).toBe(false);
    });
  });

  describe("runSocketPath", () => {
    it("puts the socket under the home's sockets folder", () => {
      expect(runSocketPath(home, "fd-run-abcd1234")).toEqual({
        kind: "ok",
        path: `${home}/sockets/fd-run-abcd1234.sock`,
      });
    });

    it("refuses a path longer than 104 characters with the CLI's message", () => {
      const longHome = `/${"h".repeat(120)}`;

      expect(runSocketPath(longHome, "fd-run-abcd1234")).toEqual({
        kind: "error",
        message: `Socket path "${longHome}/sockets/fd-run-abcd1234.sock" is longer than 104 characters`,
      });
    });
  });
});

describe("execute wiring", () => {
  const claudeSessionId = "c1";
  const promptBuild = (budget?: number) =>
    ({
      hash: "abc123",
      session: budget === undefined ? {} : { budget },
      nodes: [{ id: "n1", type: "prompt", label: "n1", settings: { instructions: "Do it." } }],
    }) as unknown as LoadedBuild;
  const twoDollars = [
    {
      messageId: "m1",
      model: "claude-opus-5-5",
      inputTokens: 0,
      outputTokens: 100_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    },
  ];

  async function executeWith(options: {
    manifest: LoadedBuild;
    waiter: FakeWaiter;
    usage: FakeUsageSource;
    compacts?: boolean;
    onSend?: (wiring: {
      events: FakeEventSource;
      permissions: FakePermissionSource;
    }) => Promise<void>;
  }) {
    const events = new FakeEventSource();
    const permissions = new FakePermissionSource();
    const store = new FakeStore();
    const sends: string[] = [];
    const lines: string[] = [];
    const { id } = store.createRun({
      buildDir: "/fd/builds/abc",
      inputs: {},
      nodeIds: options.manifest.nodes.map((node) => node.id),
      session: { tmuxName: "fd-run-abcd1234", cwd: "/repo", claudeSessionId },
      buildHash: options.manifest.hash,
    });
    const code = await execute(
      {
        fs,
        scripts: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
        waiter: options.waiter,
        usage: options.usage,
        ...(options.compacts === true ? { compactions: options.usage } : {}),
        startEvents: async () => ({ events, permissions, stop: async () => undefined }),
        openSession: async () => {
          throw new Error("execute opens the session through the execution");
        },
        store,
        onChange: (line) => lines.push(line),
      },
      {
        store,
        runId: id,
        manifest: options.manifest,
        cwd: "/repo",
        auto: false,
        socketPath: "/fd/sockets/fd-run-abcd1234.sock",
        open: async () => ({
          sessionId: claudeSessionId,
          session: { ensureStarted: async () => undefined },
          prompts: {
            interrupt: async () => undefined,
            sendPrompt: async (text) => {
              sends.push(text);
              if (text === "/compact") {
                options.usage.compacted(claudeSessionId);
                return;
              }
              await options.onSend?.({ events, permissions });
              events.publish({ kind: "Stop", sessionId: claudeSessionId, payload: {} });
            },
          },
          stop: async () => undefined,
        }),
      },
    );
    return { code, sends, store, runId: id, lines };
  }

  it("pauses at the manifest's budget before sending the first prompt", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries(claudeSessionId, twoDollars);
    const waiter = new FakeWaiter([{ decision: "stop", reason: "over" }]);

    const { code, sends } = await executeWith({ manifest: promptBuild(1), waiter, usage });

    expect(waiter.calls).toEqual([{ nodeId: "n1", kind: "budget", spend: 2, budget: 1 }]);
    expect(sends).toEqual([]);
    expect(code).toBe(1);
  });

  it("compacts a full context before the next turn when it is given a compaction reader", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries(claudeSessionId, [
      { ...(twoDollars[0] as UsageEntry), outputTokens: 0, cacheReadTokens: 900_000 },
    ]);

    const { code, sends } = await executeWith({
      manifest: promptBuild(),
      waiter: new FakeWaiter([]),
      usage,
      compacts: true,
    });

    expect(sends).toEqual(["/compact", "/abc123:n1"]);
    expect(code).toBe(0);
  });

  it("passes a permission request during a turn to the waiter", async () => {
    const waiter = new FakeWaiter([{ decision: "approve" }]);
    const decisions: PermissionDecision[] = [];

    const { code } = await executeWith({
      manifest: promptBuild(),
      waiter,
      usage: new FakeUsageSource(),
      onSend: async ({ permissions }) => {
        decisions.push(
          await permissions.ask(claudeSessionId, {
            tool_name: "Bash",
            tool_input: { command: "echo hi" },
          }),
        );
      },
    });

    expect(waiter.calls).toEqual([permissionWait]);
    expect(decisions).toEqual([{ behavior: "allow" }]);
    expect(code).toBe(0);
  });

  it("reads usage only once, after the run, for a manifest without a budget", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries(claudeSessionId, twoDollars);
    let readsDuringTurn = -1;

    const { code } = await executeWith({
      manifest: promptBuild(),
      waiter: new FakeWaiter([]),
      usage,
      onSend: async () => {
        readsDuringTurn = usage.calls.length;
      },
    });

    expect(readsDuringTurn).toBe(0);
    expect(usage.calls).toEqual([claudeSessionId]);
    expect(code).toBe(0);
  });

  it("writes the session's priced spend to the run as its total cost", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries(claudeSessionId, twoDollars);

    const { store, runId } = await executeWith({
      manifest: promptBuild(),
      waiter: new FakeWaiter([]),
      usage,
    });

    expect(store.costOf(runId)).toBe(2);
    expect(store.findRun(runId)?.status).toBe("done");
  });

  it("charges the session's usage to the node whose turn it was, as a usage event", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries(claudeSessionId, twoDollars);

    const { store, runId } = await executeWith({
      manifest: promptBuild(),
      waiter: new FakeWaiter([]),
      usage,
    });

    expect(store.events(runId).filter((event) => event.kind === "usage")).toEqual([
      expect.objectContaining({
        nodeId: "n1",
        payload: { messages: ["m1"] },
        tokens: 100_000,
        cost: 2,
      }),
    ]);
    expect(usage.calls).toEqual([claudeSessionId]);
  });

  it("still finishes the run when its spend cannot be read", async () => {
    const usage = new FakeUsageSource();
    usage.entries = async () => {
      throw new Error("transcript gone");
    };

    const { store, runId, code, lines } = await executeWith({
      manifest: promptBuild(),
      waiter: new FakeWaiter([]),
      usage,
    });

    expect(code).toBe(0);
    expect(store.costOf(runId)).toBeUndefined();
    expect(store.findRun(runId)?.status).toBe("done");
    expect(lines).toContain("cost not recorded: transcript gone");
  });
});
