import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WaitReply } from "../../../src/ports/waiter.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { build, layDown, lockBuild } from "../../../src/core/compiler/build.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit, reportPath } from "../../../src/core/compiler/emit.js";
import { hashBuild } from "../../../src/core/compiler/hash.js";
import { lower, type Manifest } from "../../../src/core/compiler/lower.js";
import { pieceOf } from "../../../src/core/compiler/pieces.js";
import { buildRecord } from "../../../src/core/compiler/record.js";
import { handoffPairs } from "../../../src/core/flow/handoff.js";
import { parseFlow } from "../../../src/core/flow/schema.js";
import { agentTurnText } from "../../../src/core/nodes/agent/execute.js";
import { decideResume } from "../../../src/core/run/resume.js";
import {
  execute,
  type LoadedBuild,
  loadBuild,
  needsClaude,
  noClaude,
  runSocketPath,
} from "../../../src/core/run/execute.js";
import type { BuildRecord } from "../../../src/core/run/store.js";
import type { PermissionDecision } from "../../../src/ports/permission-source.js";
import type { UsageEntry } from "../../../src/ports/usage-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeUsageSource } from "../../fakes/fake-usage-source.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { permission as permissionWait } from "../../fixtures/waits.js";
import { agent, gate, onMainFlow, thenWire } from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const fs = new NodeFileSystem();

const gatesOnly = () => onMainFlow([gate("write"), gate("check")], [thenWire("write", "check")]);

const approve: WaitReply = { decision: "approve" };

const manifestWith = (types: string[]) =>
  ({
    nodes: types.map((type, index) => ({ id: `n${index}`, type })),
  }) as unknown as Manifest & { hash: string };

const buildId = "b1111111-0000-4000-8000-000000000001";

const oldRow = (hash: string, dir: string): BuildRecord => ({
  id: hash,
  hash,
  name: null,
  repo: null,
  base: null,
  values: null,
  deletedAt: null,
  dir,
  createdAt: 0,
  blueprintName: null,
  blueprintVersion: null,
});

const rows = (...records: BuildRecord[]) => ({
  findBuild: (id: string) => records.find((record) => record.id === id),
});

describe("the core run path", () => {
  let home: string;
  let repo: TmpRepo;
  let dir: string;
  let store: FakeStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    const result = await build(gatesOnly(), {
      fs,
      home,
      workspace: { id: buildId, name: "fix-login", repo: "/work/repo", base: "main", values: {} },
    });
    if (!result.ok) throw new Error("build failed");
    dir = result.dir;
    store = new FakeStore();
    store.recordBuild(result.record);
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  const loaded = async () => {
    const result = await loadBuild(buildId, { fs, store });
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

  const legacyBuild = async (
    nodes: unknown[] = [
      { id: "s", type: "gate", label: "s", settings: { shown: "Check", skippable: false } },
    ],
    wires: unknown[] = [],
  ) => {
    const manifestWithoutHash = {
      version: 1,
      session: { name: "main", workingFolder: { kind: "worktree", branch: "main" } },
      nodes,
      wires,
      files: {},
    };
    const hash = hashBuild([
      { path: "manifest.json", content: canonicalJson(manifestWithoutHash) },
    ]);
    const legacyDir = join(home, "builds", hash);
    await fs.writeFile(
      join(legacyDir, "manifest.json"),
      canonicalJson({ ...manifestWithoutHash, hash }),
    );
    return { hash, legacyDir };
  };

  describe("loadBuild", () => {
    it("finds a build by its id and loads its verified manifest", async () => {
      const result = await loadBuild(buildId, { fs, store });

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(result.build.nodes.map((node) => node.id)).toEqual([
        "start",
        "write",
        "check",
        "stop",
      ]);
      expect(result.build.hash).toBe(store.findBuild(buildId)?.hash);
    });

    it("takes the prefix from the manifest, and gives a workspace build its worktree", async () => {
      const build = await loaded();

      expect(build.prefix).toBe("fix-login");
      expect(build.layout).toBe("workspace");
      expect(build.worktree).toBe(join(dir, "repo"));
    });

    it("keeps each node's piece and the kit version a build was made with", async () => {
      const files = emit(lower(gatesOnly(), { name: "fix-login", values: {} }), {
        repo: "/work/repo",
        base: "main",
      }).map((file) => {
        if (file.path !== "manifest.json") return file;
        const manifest = JSON.parse(file.content) as Manifest;
        const nodes = manifest.nodes.map((node) => ({ ...node, piece: `piece-${node.id}` }));
        return {
          ...file,
          content: canonicalJson({ ...manifest, nodes, kitVersion: "abc123def456" }),
        };
      });
      const hash = hashBuild(files.filter((file) => file.path !== reportPath));
      const pieceDir = join(home, "workspaces", "pieces");
      for (const file of files) {
        const content =
          file.path === "manifest.json"
            ? canonicalJson({ ...(JSON.parse(file.content) as object), hash })
            : file.content;
        await fs.writeFile(join(pieceDir, file.path), content);
      }
      const row = { ...oldRow(hash, pieceDir), id: "pieces", name: "pieces" };

      const result = await loadBuild("pieces", { fs, store: rows(row) });

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(result.build.nodes.map(pieceOf)).toEqual([
        "piece-start",
        "piece-write",
        "piece-check",
        "piece-stop",
      ]);
      expect(result.build.kitVersion).toBe("abc123def456");
    });

    it("falls back to the node id as the piece of a build that named none", async () => {
      const build = await loaded();

      expect(build.nodes.map(pieceOf)).toEqual(["start", "write", "check", "stop"]);
      expect(build.kitVersion).toBeUndefined();
    });

    it("ignores the files in the build's worktree", async () => {
      await fs.writeFile(join(dir, "repo", "src", "login.ts"), "export {};\n");
      await fs.writeFile(join(dir, "repo", ".git"), "gitdir: /work/repo/.git/worktrees/repo\n");

      expect((await loadBuild(buildId, { fs, store })).kind).toBe("loaded");
    });

    it("refuses a build with a changed file, naming the file", async () => {
      const files = (await fs.list(join(dir, "plugin"))).map((path) => `plugin/${path}`);
      const changed = files[0];
      if (changed === undefined) throw new Error("the build has no plugin file");
      await writeFile(join(dir, changed), "tampered\n");

      expect(await loadBuild(buildId, { fs, store })).toEqual({
        kind: "error",
        message: `${changed}: changed`,
      });
    });

    it("verifies the folder against the hash its row records", async () => {
      const row = store.findBuild(buildId);
      if (row === undefined) throw new Error("the build is not recorded");
      const otherHash = "0".repeat(64);

      expect(await loadBuild(buildId, { fs, store: rows({ ...row, hash: otherHash }) })).toEqual({
        kind: "error",
        message: "manifest.json: changed",
      });
    });

    it("loads an old hash-named build from its flat folder, with the hash as its prefix", async () => {
      const { hash, legacyDir } = await legacyBuild();

      const result = await loadBuild(hash, { fs, store: rows(oldRow(hash, legacyDir)) });

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(result.build.hash).toBe(hash);
      expect(result.build.prefix).toBe(hash);
      expect(result.build.layout).toBe("legacy");
      expect(result.build.worktree).toBeUndefined();
    });

    it("runs an old build's File wire as a hand-off pair, leaving its verified manifest as it was", async () => {
      const agentNode = (id: string) => ({
        id,
        type: "agent",
        label: id,
        settings: { instructions: `Do ${id}.` },
      });
      const { hash, legacyDir } = await legacyBuild(
        [agentNode("plan"), agentNode("build")],
        [
          { kind: "then", from: { node: "plan", port: "out" }, to: { node: "build", port: "in" } },
          {
            kind: "file",
            from: { node: "plan", port: "file-out" },
            to: { node: "build", port: "file-in" },
            file: "plan.md",
          },
        ],
      );
      const onDisk = await readFile(join(legacyDir, "manifest.json"), "utf8");

      const result = await loadBuild(hash, { fs, store: rows(oldRow(hash, legacyDir)) });

      if (result.kind !== "loaded") throw new Error(`build not loaded: ${result.message}`);
      expect(handoffPairs(result.build.nodes)).toEqual([
        { file: "plan.md", reader: "build", writers: ["plan"] },
      ]);
      expect(result.build.wires.map((wire) => wire.kind)).toEqual(["then"]);
      expect(await readFile(join(legacyDir, "manifest.json"), "utf8")).toBe(onDisk);
    });

    it("still names any file an old build did not write, anywhere in its folder", async () => {
      const { hash, legacyDir } = await legacyBuild();
      await fs.writeFile(join(legacyDir, "notes", ".DS_Store"), "");

      expect(await loadBuild(hash, { fs, store: rows(oldRow(hash, legacyDir)) })).toEqual({
        kind: "error",
        message: "notes/.DS_Store: extra",
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
      const files = emit(lower(broken, { name: "fix-login", values: {} }), {
        repo: "/work/repo",
        base: "main",
      });
      const hash = hashBuild(files.filter((file) => file.path !== reportPath));
      const brokenDir = join(home, "workspaces", "broken");
      for (const file of files) {
        const content =
          file.path === "manifest.json"
            ? canonicalJson({ ...(JSON.parse(file.content) as object), hash })
            : file.content;
        await fs.writeFile(join(brokenDir, file.path), content);
      }
      const row = { ...oldRow(hash, brokenDir), id: "broken", name: "broken" };

      const result = await loadBuild("broken", { fs, store: rows(row) });

      expect(result.kind).toBe("error");
      expect(result.kind === "error" ? result.message : "").toMatch(
        /^cannot run this build: .*split\b.*has 1 branches; a parallel start needs two or more\.$/,
      );
    });

    it("refuses a build whose folder is gone", async () => {
      const row = store.findBuild(buildId);
      if (row === undefined) throw new Error("the build is not recorded");
      const gone = { ...row, dir: join(home, "workspaces", "nope") };

      expect((await loadBuild(buildId, { fs, store: rows(gone) })).kind).toBe("error");
    });

    it("refuses an id no build has", async () => {
      expect((await loadBuild("nope", { fs, store })).kind).toBe("error");
    });
  });

  describe("execute", () => {
    it("runs a build with no Claude turn and records it done", async () => {
      const build = await loaded();
      const store = new FakeStore();
      const events = startEvents();
      const lines: string[] = [];
      const { id } = store.createRun({
        buildDir: dir,
        inputs: {},
        nodeIds: build.nodes.map((node) => node.id),
        session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
        buildId,
      });

      const code = await execute(
        {
          fs,
          waiter: new FakeWaiter([approve, approve]),
          startEvents: events.startEvents,
          openSession: async () => {
            throw new Error("Claude must not start for a flow with no Claude turn");
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
      expect(lines).toEqual(["write approved", "check approved", "stop done"]);
      expect(events.stops()).toBe(1);
      expect(store.runs[0]?.status).toBe("done");
    });

    it("records the run stopped when interrupted while a Gate waits", async () => {
      const build = await loaded();
      const store = new FakeStore();
      const events = startEvents();
      let interrupt: (code: number) => void = () => undefined;
      let release: (reply: WaitReply) => void = () => undefined;
      const blocked = new Promise<WaitReply>((resolve) => (release = resolve));
      const { id } = store.createRun({
        buildDir: dir,
        inputs: {},
        nodeIds: build.nodes.map((node) => node.id),
        session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
        buildId,
      });

      const code = await execute(
        {
          fs,
          waiter: {
            wait: () => {
              interrupt(130);
              return blocked;
            },
          },
          startEvents: events.startEvents,
          openSession: async () => {
            throw new Error("Claude must not start for a flow with no Claude turn");
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
      release(approve);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(code).toBe(130);
      expect(store.runs[0]?.status).toBe("stopped");
    });
  });

  describe("needsClaude", () => {
    it("is true for a manifest with an agent node", () => {
      expect(needsClaude(manifestWith(["gate", "agent"]))).toBe(true);
    });

    it("is false for gates and asks only", () => {
      expect(needsClaude(manifestWith(["gate", "ask"]))).toBe(false);
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

    it("refuses a path longer than 104 characters, naming the path", () => {
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
  const agentBuild = (budget?: number) =>
    ({
      hash: "abc123",
      prefix: "fix-login",
      session: budget === undefined ? {} : { budget },
      nodes: [
        {
          id: "n1",
          type: "agent",
          label: "n1",
          settings: { role: "", instructions: "Do it.", model: "sonnet", tools: [] },
        },
      ],
    }) as unknown as LoadedBuild;
  const n1Done = {
    tool_name: "Agent",
    tool_input: { subagent_type: "fix-login:n1", prompt: "NODE n1\nGo" },
    tool_use_id: "toolu-n1",
    tool_response: {
      status: "completed",
      agentId: "agent-n1",
      agentType: "fix-login:n1",
      content: [],
    },
  };
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
      buildId: options.manifest.hash,
    });
    const code = await execute(
      {
        fs,
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
              events.publish({ kind: "PostToolUse", sessionId: claudeSessionId, payload: n1Done });
              events.publish({ kind: "Stop", sessionId: claudeSessionId, payload: {} });
            },
          },
          stop: async () => undefined,
        }),
      },
    );
    return { code, sends, store, runId: id, lines };
  }

  it("stops a session whose start finishes after the run was stopped, and sends nothing", async () => {
    const store = new FakeStore();
    const manifest = agentBuild();
    const log: string[] = [];
    let interrupt: (code: number) => void = () => undefined;
    let finishStart: () => void = () => undefined;
    const starting = new Promise<void>((resolve) => (finishStart = resolve));
    const { id } = store.createRun({
      buildDir: "/fd/builds/abc",
      inputs: {},
      nodeIds: manifest.nodes.map((node) => node.id),
      session: { tmuxName: "fd-run-abcd1234", cwd: "/repo", claudeSessionId },
      buildId: manifest.hash,
    });

    const code = await execute(
      {
        fs,
        waiter: new FakeWaiter([]),
        startEvents: async () => ({ events: new FakeEventSource(), stop: async () => undefined }),
        openSession: async () => {
          throw new Error("execute opens the session through the execution");
        },
        store,
        onChange: () => undefined,
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => undefined;
        },
      },
      {
        store,
        runId: id,
        manifest,
        cwd: "/repo",
        auto: false,
        socketPath: "/fd/sockets/fd-run-abcd1234.sock",
        open: async () => ({
          sessionId: claudeSessionId,
          session: {
            ensureStarted: async () => {
              log.push("start requested");
              interrupt(130);
              await starting;
              log.push("started");
            },
          },
          prompts: {
            interrupt: async () => undefined,
            sendPrompt: async (text) => {
              log.push(`send ${text}`);
            },
          },
          stop: async () => {
            log.push("session stopped");
          },
        }),
      },
    );
    finishStart();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(code).toBe(130);
    expect(log).toContain("started");
    expect(log.slice(log.indexOf("started"))).toContain("session stopped");
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual([]);
    expect(store.findRun(id)?.status).toBe("stopped");
  });

  it("pauses at the manifest's budget before sending the first agent", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries(claudeSessionId, twoDollars);
    const waiter = new FakeWaiter([{ decision: "stop", reason: "over" }]);

    const { code, sends } = await executeWith({ manifest: agentBuild(1), waiter, usage });

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
      manifest: agentBuild(),
      waiter: new FakeWaiter([]),
      usage,
      compacts: true,
    });

    expect(sends).toEqual([
      "/compact",
      agentTurnText("fix-login", "n1", { id: "n1", given: [], writes: [] }),
    ]);
    expect(code).toBe(0);
  });

  it("passes a permission request during a turn to the waiter", async () => {
    const waiter = new FakeWaiter([{ decision: "approve" }]);
    const decisions: PermissionDecision[] = [];

    const { code } = await executeWith({
      manifest: agentBuild(),
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
      manifest: agentBuild(),
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
      manifest: agentBuild(),
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
      manifest: agentBuild(),
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
      manifest: agentBuild(),
      waiter: new FakeWaiter([]),
      usage,
    });

    expect(code).toBe(0);
    expect(store.costOf(runId)).toBeUndefined();
    expect(store.findRun(runId)?.status).toBe("done");
    expect(lines).toContain("cost not recorded: transcript gone");
  });
});

describe("AT-19: a build that named no pieces", () => {
  const id = "b1111111-0000-4000-8000-000000000019";
  const claudeSessionId = "c19";
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("runs, resumes and reports cost through loadBuild, decideResume and chargeUsage", async () => {
    const store = new FakeStore();
    const workspace = { id, name: "fix-login", repo: "/work/repo", base: "main", values: {} };
    const laid = await layDown(
      onMainFlow(
        [agent("p1"), agent("a1"), agent("p2")],
        [thenWire("p1", "a1"), thenWire("a1", "p2")],
      ),
      { home, workspace },
    );
    if (!laid.ok) throw new Error("build failed");
    const unnamed = laid.files.map((file) => {
      if (file.path !== "manifest.json") return file;
      const manifest = JSON.parse(file.content) as Manifest;
      for (const node of manifest.nodes) delete node.piece;
      return { ...file, content: canonicalJson(manifest) };
    });
    const dir = join(home, "workspaces", id);
    const { manifest: locked } = await lockBuild(fs, dir, unnamed);
    const built = { dir, record: buildRecord(dir, locked, workspace) };
    store.recordBuild(built.record);
    const loadedBuild = await loadBuild(id, { fs, store });
    if (loadedBuild.kind !== "loaded") throw new Error(loadedBuild.message);
    const manifest = loadedBuild.build;
    expect(manifest.nodes.some((node) => node.piece !== undefined)).toBe(false);
    const { id: runId } = store.createRun({
      buildDir: built.dir,
      inputs: {},
      nodeIds: manifest.nodes.map((node) => node.id),
      session: { tmuxName: "fd-run-fd61", cwd: "/repo", claudeSessionId },
      buildId: id,
    });
    store.append(runId, "p1", { kind: "sent" });
    store.append(runId, "p1", { kind: "done" });
    store.append(runId, "a1", { kind: "sent" });
    const turns = [
      {
        userText:
          'Use the Agent tool with subagent_type "fix-login:p1" and the prompt "Go". Then reply DONE.',
        ended: true,
        lastAssistantText: "DONE",
      },
      {
        userText:
          'Use the Agent tool with subagent_type "fix-login:a1" and the prompt "Go". Then reply DONE.',
        ended: true,
        lastAssistantText: "DONE",
      },
    ];
    const usage = new FakeUsageSource();
    const spend = (messageId: string, agentType?: string): UsageEntry => ({
      messageId,
      model: "claude-haiku-5-5",
      inputTokens: 0,
      outputTokens: 1000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      ...(agentType === undefined ? {} : { agentType }),
    });
    usage.setEntries(claudeSessionId, [spend("sub_a1", "fix-login:a1"), spend("main_p2")]);
    const events = new FakeEventSource();
    const sends: string[] = [];

    const code = await execute(
      {
        fs,
        waiter: new FakeWaiter([]),
        usage,
        startEvents: async () => ({ events, stop: async () => undefined }),
        openSession: async () => {
          throw new Error("execute opens the session through the execution");
        },
        store,
        onChange: () => undefined,
      },
      {
        store,
        runId,
        manifest,
        cwd: "/repo",
        auto: false,
        socketPath: "/fd/sockets/fd-run-fd61.sock",
        actions: async () => decideResume({ manifest, events: store.events(runId), turns }),
        open: async () => ({
          sessionId: claudeSessionId,
          session: { ensureStarted: async () => undefined },
          prompts: {
            interrupt: async () => undefined,
            sendPrompt: async (text) => {
              sends.push(text);
              events.publish({
                kind: "PostToolUse",
                sessionId: claudeSessionId,
                payload: {
                  tool_name: "Agent",
                  tool_input: { subagent_type: "fix-login:p2", prompt: "NODE p2\nGo" },
                  tool_use_id: "toolu-p2",
                  tool_response: {
                    status: "completed",
                    agentId: "agent-p2",
                    agentType: "fix-login:p2",
                    content: [],
                  },
                },
              });
              events.publish({ kind: "Stop", sessionId: claudeSessionId, payload: {} });
            },
          },
          stop: async () => undefined,
        }),
      },
    );

    expect(code).toBe(0);
    expect(sends).toEqual([agentTurnText("fix-login", "p2", { id: "p2", given: [], writes: [] })]);
    expect(store.findRun(runId)?.status).toBe("done");
    const charged = Object.fromEntries(
      store
        .events(runId)
        .flatMap((event) =>
          event.kind === "usage" ? [[event.nodeId, event.payload.messages]] : [],
        ),
    );
    expect(charged).toEqual({ a1: ["sub_a1"], p2: ["main_p2"] });
  });
});
