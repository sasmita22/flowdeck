import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitFolderState } from "../../src/adapters/git/git-state.js";
import { GitWorktree } from "../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { SessionGoneError } from "../../src/adapters/claude/claude-session.js";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { runCli, type CliDeps } from "../../src/cli/main.js";
import { buildVersion } from "../../src/core/compiler/build-version.js";
import { canonicalJson } from "../../src/core/compiler/canonical-json.js";
import { hashBuild } from "../../src/core/compiler/hash.js";
import type { BuildConfig, Flow } from "../../src/core/flow/schema.js";
import type { VariableValues } from "../../src/core/flow/variables.js";
import type { TranscriptTurn } from "../../src/core/run/resume.js";
import type { RunEvent } from "../../src/core/run/run-events.js";
import type { FlowStore } from "../../src/ports/flow-store.js";
import type { ProcessResult } from "../../src/ports/process-runner.js";
import type { Store } from "../../src/ports/store.js";
import type { WaitReply } from "../../src/ports/waiter.js";
import { FakeBuildAgents } from "../fakes/fake-build-agents.js";
import { FakeConnectorSource } from "../fakes/fake-connector-source.js";
import { FakeEventSource } from "../fakes/fake-event-source.js";
import { FakeFlowStore } from "../fakes/fake-flow-store.js";
import { FakeProcessRunner } from "../fakes/fake-process-runner.js";
import { FakeStore } from "../fakes/fake-store.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import {
  agent,
  ask,
  branch,
  flow,
  gate,
  loop,
  output,
  prompt,
  script,
  thenWire,
  trigger,
  wire,
} from "../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";
import { fakeBuildDeps, fakeCliBuild } from "../fixtures/fake-build-deps.js";

const git = promisify(execFile);

const shScript = (id: string) => script(id, { settings: { command: "sh" } });

const sessionId = "s1";
const hooks = { nodePath: "/n", hookScriptPath: "/h" };
const jira = { type: "http", url: "https://mcp.example.com/jira" };
const ok: ProcessResult = { code: 0, stdout: "", stderr: "" };
const failed: ProcessResult = { code: 1, stdout: "", stderr: "" };

let home: string;
let repo: TmpRepo;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fd-home-"));
  repo = await createTmpRepo({ commit: true });
});

afterEach(async () => {
  await repo.cleanup();
  await rm(home, { recursive: true, force: true });
});

const idSequence = () => {
  let next = 0;
  return () => `${String(++next).padStart(8, "0")}-0000-4000-8000-000000000000`;
};

type Variable = BuildConfig["variables"][number];

const withConfig = (
  input: Flow,
  config: { variables?: Variable[]; base?: string | null; connectors?: string[] },
): Flow => {
  const buildConfig = { ...input.session.buildConfig };
  if (config.base === null) delete buildConfig.base;
  else if (config.base !== undefined) buildConfig.base = config.base;
  if (config.variables !== undefined) buildConfig.variables = config.variables;
  return {
    ...input,
    session: {
      ...input.session,
      ...(config.connectors === undefined ? {} : { connectors: config.connectors }),
      buildConfig,
    },
  };
};

const isPrivate = async (path: string) => ((await stat(path)).mode & 0o777) === 0o600;

const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const branchOf = async (folder: string) =>
  (await git("git", ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();

const toplevelOf = async (folder: string) =>
  (await git("git", ["-C", folder, "rev-parse", "--show-toplevel"])).stdout.trim();

type Seeded = { id: string; hash: string; dir: string; worktree: string };

type Recorded = {
  startEvents: string[];
  openSession: Parameters<CliDeps["openSession"]>[0][];
  sends: string[];
  sessionStops: number;
  eventStops: number;
  stdout: string[];
  stderr: string[];
  storePaths: string[];
  order: string[];
};

function stubDeps(
  options: {
    env?: Record<string, string>;
    results?: ProcessResult[];
    finishedAgents?: string[];
    waiter?: FakeWaiter;
    turns?: TranscriptTurn[];
    sessionGone?: boolean;
    connectors?: FakeConnectorSource;
    stores?: { runs: Store; flows: FlowStore };
  } = {},
) {
  const source = new FakeEventSource();
  const store = new FakeStore();
  const stores = options.stores ?? { runs: store, flows: new FakeFlowStore() };
  const scripts = new FakeProcessRunner(options.results ?? []);
  const fs = new NodeFileSystem();
  const newId = idSequence();
  const gitState = new GitFolderState();
  const worktree = new GitWorktree();
  const recorded: Recorded = {
    startEvents: [],
    openSession: [],
    sends: [],
    sessionStops: 0,
    eventStops: 0,
    stdout: [],
    stderr: [],
    storePaths: [],
    order: [],
  };
  const deps: CliDeps = {
    env: options.env ?? { FLOWDECK_HOME: home },
    stdout: (line) => recorded.stdout.push(line),
    stderr: (line) => recorded.stderr.push(line),
    fs,
    scripts,
    hooks,
    build: fakeCliBuild(fs),
    connectors: options.connectors ?? new FakeConnectorSource({ jira }),
    gitState,
    worktree,
    newId,
    waiter: options.waiter ?? new FakeWaiter([]),
    openStore: (path) => {
      recorded.storePaths.push(path);
      return stores;
    },
    transcriptTurns: async (claudeSessionId) => {
      recorded.order.push(`transcript ${claudeSessionId}`);
      return options.turns ?? [];
    },
    startEvents: async (socketPath) => {
      recorded.startEvents.push(socketPath);
      recorded.order.push("listen");
      return {
        events: source,
        stop: async () => {
          recorded.eventStops++;
        },
      };
    },
    openSession: async (session) => {
      recorded.openSession.push(session);
      if (session.attach === true && options.sessionGone === true) {
        throw new SessionGoneError(session.sessionName);
      }
      return {
        sessionId,
        session: { ensureStarted: async () => undefined },
        prompts: {
          interrupt: async () => undefined,
          sendPrompt: async (text) => {
            recorded.sends.push(text);
            setTimeout(() => {
              for (const nodeId of options.finishedAgents ?? []) {
                source.publish({
                  kind: "PostToolUse",
                  sessionId,
                  payload: {
                    tool_name: "Agent",
                    tool_input: { prompt: `NODE ${nodeId}\nGo` },
                    tool_use_id: `toolu-${nodeId}`,
                    tool_response: { status: "completed" },
                  },
                });
              }
              source.publish({ kind: "Stop", sessionId, payload: {} });
            }, 0);
          },
        },
        stop: async () => {
          recorded.sessionStops++;
        },
      };
    },
  };
  const seed = async (
    input: Flow,
    request: { name?: string; values?: VariableValues } = {},
  ): Promise<Seeded> => {
    const ref = stores.flows.save(input);
    const result = await buildVersion(
      ref,
      { name: request.name ?? "x", repo: repo.path, values: request.values ?? {} },
      {
        flows: stores.flows,
        store: stores.runs,
        fs,
        home,
        connectors: new FakeConnectorSource({ jira }),
        gitState,
        worktree,
        newId,
        now: Date.now,
        ...fakeBuildDeps(fs, home),
      },
    );
    if (!result.ok) throw new Error(`seed build failed: ${JSON.stringify(result.errors)}`);
    return {
      id: result.record.id,
      hash: result.hash,
      dir: result.dir,
      worktree: join(result.dir, basename(repo.path)),
    };
  };
  return { deps, recorded, scripts, store, source, seed };
}

const promptThenScript = () =>
  flow(
    [prompt("p1"), script("s1", { settings: { command: "npm", args: ["test"] } })],
    [thenWire("p1", "s1")],
  );

const nothingStarted = (recorded: Recorded, scripts: FakeProcessRunner) => {
  expect(recorded.startEvents).toEqual([]);
  expect(recorded.openSession).toEqual([]);
  expect(scripts.calls).toEqual([]);
};

describe("runCli run", () => {
  it.each([
    [[]],
    [["launch"]],
    [["run"]],
    [["run", "x", "y"]],
    [["run", "x", "--cwd", "/somewhere"]],
    [["run", "x", "--colour"]],
    [["run", "x", "--e2e"]],
    [["run", "x", "--no-e2e"]],
    [["run", "x", "--no-auto"]],
  ])("refuses the arguments %j with usage and exit 2", async (argv) => {
    const { deps, recorded, scripts, store, seed } = stubDeps();
    await seed(withConfig(promptThenScript(), { variables: [{ name: "e2e", kind: "yesno" }] }), {
      values: { e2e: true },
    });

    expect(await runCli(argv, deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("Usage:");
    nothingStarted(recorded, scripts);
    expect(store.runs).toEqual([]);
  });

  it("refuses a name no build has, naming it, and starts nothing", async () => {
    const { deps, recorded, scripts, store, seed } = stubDeps();
    await seed(promptThenScript());

    expect(await runCli(["run", "nope"], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("nope");
    nothingStarted(recorded, scripts);
    expect(store.runs).toEqual([]);
  });

  it("refuses a session name outside fd-", async () => {
    const { deps, recorded, scripts, seed } = stubDeps();
    await seed(promptThenScript());

    expect(await runCli(["run", "x", "--session", "mine"], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("mine");
    nothingStarted(recorded, scripts);
  });

  it("names the session fd-run-<short id> by default", async () => {
    const { deps, recorded, seed } = stubDeps({ results: [ok] });
    await seed(promptThenScript());

    await runCli(["run", "x"], deps);

    expect(recorded.openSession[0]?.sessionName).toMatch(/^fd-run-[0-9a-f]{8}$/);
  });

  it("refuses a hook socket path longer than the platform limit", async () => {
    const longHome = `/${"h".repeat(120)}`;
    const { deps, recorded, scripts, seed } = stubDeps();
    await seed(promptThenScript());
    deps.env = { FLOWDECK_HOME: longHome };

    expect(await runCli(["run", "x"], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("longer than 104");
    nothingStarted(recorded, scripts);
  });

  it("puts the hook socket under ~/.flowdeck when FLOWDECK_HOME is unset", async () => {
    const { deps, recorded, seed } = stubDeps({ results: [ok] });
    await seed(promptThenScript());
    deps.env = {};

    await runCli(["run", "x", "--session", "fd-x"], deps);

    expect(recorded.startEvents).toEqual([join(homedir(), ".flowdeck", "sockets", "fd-x.sock")]);
  });

  it("refuses a tampered build before starting anything, printing each problem", async () => {
    const { deps, recorded, scripts, store, seed } = stubDeps();
    const { dir } = await seed(promptThenScript());
    await mkdir(join(dir, "plugin", "skills", "p1"), { recursive: true });
    await writeFile(join(dir, "plugin", "skills", "p1", "SKILL.md"), "tampered\n");
    await writeFile(join(dir, "plugin", "skills", "p1", "extra.md"), "extra\n");

    expect(await runCli(["run", "x"], deps)).toBe(2);
    expect(recorded.stderr).toEqual(
      expect.arrayContaining([
        expect.stringContaining("plugin/skills/p1/SKILL.md: changed"),
        expect.stringContaining("plugin/skills/p1/extra.md: extra"),
      ]),
    );
    expect(recorded.stdout).toEqual([]);
    nothingStarted(recorded, scripts);
    expect(store.runs).toEqual([]);
  });

  describe("gates and asks", () => {
    const echoed = (text: string): ProcessResult => ({ code: 0, stdout: `${text}\n`, stderr: "" });
    const approve: WaitReply = { decision: "approve" };

    const gateFlow = (skippable = false) =>
      flow(
        [script("s1"), gate("g1", { settings: { skippable } }), script("s2")],
        [thenWire("s1", "g1"), thenWire("g1", "s2")],
      );

    it("runs past an approved Gate without starting Claude", async () => {
      const { deps, recorded, seed } = stubDeps({
        results: [echoed("one"), echoed("two")],
        waiter: new FakeWaiter([approve]),
      });
      await seed(gateFlow());

      expect(await runCli(["run", "x"], deps)).toBe(0);
      expect(recorded.stdout).toEqual([
        "s1 started",
        "  one",
        "s1 done",
        "g1 approved",
        "s2 started",
        "  two",
        "s2 done",
      ]);
      expect(recorded.openSession).toEqual([]);
    });

    it("exits 1 at a rejected Gate, printing the reason, and runs nothing after it", async () => {
      const { deps, recorded, scripts, seed } = stubDeps({
        results: [echoed("one"), echoed("two")],
        waiter: new FakeWaiter([{ decision: "reject", reason: "wrong scope" }]),
      });
      await seed(gateFlow());

      expect(await runCli(["run", "x"], deps)).toBe(1);
      expect(recorded.stdout.at(-1)).toBe("g1 failed: rejected: wrong scope");
      expect(scripts.calls).toHaveLength(1);
    });

    it("passes --auto to the run, so a skippable Gate is skipped without asking", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, recorded, seed } = stubDeps({ results: [ok, ok], waiter });
      await seed(gateFlow(true));

      expect(await runCli(["run", "x", "--auto"], deps)).toBe(0);
      expect(recorded.stdout).toContain("g1 skipped");
      expect(waiter.calls).toEqual([]);
    });

    it("asks at a skippable Gate without --auto", async () => {
      const waiter = new FakeWaiter([approve]);
      const { deps, seed } = stubDeps({ results: [ok, ok], waiter });
      await seed(gateFlow(true));

      expect(await runCli(["run", "x"], deps)).toBe(0);
      expect(waiter.calls).toHaveLength(1);
    });

    it("answers an Ask before a Script without starting Claude", async () => {
      const { deps, recorded, seed } = stubDeps({
        results: [ok],
        waiter: new FakeWaiter([{ decision: "answer", answer: "blue" }]),
      });
      await seed(flow([ask("q1"), script("s1")], [thenWire("q1", "s1")]));

      expect(await runCli(["run", "x"], deps)).toBe(0);
      expect(recorded.stdout).toEqual(["q1 answered: blue", "s1 started", "s1 done"]);
      expect(recorded.openSession).toEqual([]);
    });

    it("shows the build-name form of run in the usage, with no --cwd", async () => {
      const { deps, recorded } = stubDeps();

      await runCli(["run"], deps);

      const usage = recorded.stderr.join("\n");
      expect(usage).toContain("flowdeck run <build-name>");
      expect(usage).toContain("[--auto]");
      expect(usage).not.toContain("--cwd");
    });
  });

  it("starts Claude and runs an agent-only build", async () => {
    const { deps, recorded, seed } = stubDeps({ finishedAgents: ["a1"] });
    await seed(
      flow([trigger("t"), agent("a1"), output("o")], [thenWire("t", "a1"), thenWire("a1", "o")]),
    );

    expect(await runCli(["run", "x", "--session", "fd-a"], deps)).toBe(0);
    expect(recorded.openSession).toHaveLength(1);
    expect(recorded.stdout).toEqual(["a1 started", "a1 done", "o done"]);
  });

  it("runs the build in its own worktree, passing the workspace, model and socket to the session", async () => {
    const { deps, recorded, scripts, seed } = stubDeps({ results: [ok] });
    const { dir, worktree } = await seed(promptThenScript());

    expect(await runCli(["run", "x", "--session", "fd-a"], deps)).toBe(0);
    expect(recorded.openSession).toEqual([
      {
        sessionName: "fd-a",
        buildDir: dir,
        layout: "workspace",
        model: "sonnet",
        socketPath: join(home, "sockets", "fd-a.sock"),
        cwd: worktree,
        claudeSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        hooks,
      },
    ]);
    expect(recorded.sends).toEqual(["/x:p1 NODE p1"]);
    expect(scripts.calls).toEqual([{ command: "npm", args: ["test"], cwd: worktree }]);
    expect(recorded.stdout).toEqual(["p1 started", "p1 done", "s1 started", "s1 done"]);
  });

  it("runs each build in its own worktree, never the target repo", async () => {
    const { deps, scripts, seed } = stubDeps({ results: [ok, ok] });
    const a = await seed(flow([script("s1")], []), { name: "a" });
    const b = await seed(flow([script("s1")], []), { name: "b" });

    expect(await runCli(["run", "b"], deps)).toBe(0);
    expect(await runCli(["run", "a"], deps)).toBe(0);

    expect(scripts.calls.map((call) => call.cwd)).toEqual([b.worktree, a.worktree]);
    expect(await toplevelOf(b.worktree)).toBe(await realpath(b.worktree));
    expect(await branchOf(b.worktree)).toBe(`flowdeck/b-${b.id.slice(0, 8)}`);
    expect(scripts.calls.map((call) => call.cwd)).not.toContain(repo.path);
  });

  it("starts the session with the run's own private MCP config when the build has connectors", async () => {
    const { deps, recorded, seed } = stubDeps({ results: [ok] });
    const { dir } = await seed(withConfig(promptThenScript(), { connectors: ["jira"] }));

    expect(await runCli(["run", "x"], deps)).toBe(0);

    const runId = recorded.stderr[0]?.replace(/^run /, "");
    const runtimePath = join(home, "runs", runId ?? "", "mcp.json");
    expect(recorded.openSession[0]?.mcpConfigPath).toBe(runtimePath);
    expect(await isPrivate(runtimePath)).toBe(true);
    expect(JSON.parse(await deps.fs.readFile(runtimePath))).toEqual({ mcpServers: { jira } });
    expect(await readdir(dir)).not.toContain("mcp.json");
  });

  it("refuses to run a build whose connector Claude Code no longer has, before anything starts", async () => {
    const { deps, recorded, scripts, seed } = stubDeps({
      results: [ok],
      connectors: new FakeConnectorSource(),
    });
    await seed(withConfig(promptThenScript(), { connectors: ["jira"] }));

    expect(await runCli(["run", "x"], deps)).toBe(2);

    expect(recorded.stderr).toEqual([
      expect.stringMatching(/^connectors: Connector "jira" is not set up in Claude Code/),
    ]);
    nothingStarted(recorded, scripts);
  });

  it("starts the session with the --model value when given", async () => {
    const { deps, recorded, seed } = stubDeps({ results: [ok] });
    await seed(promptThenScript());

    await runCli(["run", "x", "--model", "haiku"], deps);

    expect(recorded.openSession[0]?.model).toBe("haiku");
  });

  it("exits 1 when a node fails", async () => {
    const { deps, recorded, seed } = stubDeps({ results: [failed] });
    await seed(promptThenScript());

    expect(await runCli(["run", "x"], deps)).toBe(1);
    expect(recorded.stdout.at(-1)).toBe("s1 failed: exit code 1");
  });

  describe("cleanup", () => {
    it.each([
      ["success", [ok], 0],
      ["a failed node", [failed], 1],
    ] as const)("stops the session and the events after %s", async (_, results, code) => {
      const { deps, recorded, seed } = stubDeps({ results: [...results] });
      await seed(promptThenScript());

      expect(await runCli(["run", "x"], deps)).toBe(code);
      expect(recorded.sessionStops).toBe(1);
      expect(recorded.eventStops).toBe(1);
    });

    it("stops the session and the events when the runner throws", async () => {
      const { deps, recorded, seed } = stubDeps({ results: [ok] });
      await seed(promptThenScript());
      const throwing: CliDeps = {
        ...deps,
        stdout: () => {
          throw new Error("stdout closed");
        },
      };

      expect(await runCli(["run", "x"], throwing)).toBe(1);
      expect(recorded.stderr.join("\n")).toContain("stdout closed");
      expect(recorded.sessionStops).toBe(1);
      expect(recorded.eventStops).toBe(1);
    });
  });
});

describe("runCli run of a build that already has a run going", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase({ path: join(home, "flowdeck.db") });
  });

  afterEach(() => {
    db.close();
  });

  const sqliteDeps = (results: ProcessResult[] = []) => {
    const runs = new SqliteStore({ db });
    const flows = new SqliteFlowStore({ db });
    return { runs, ...stubDeps({ results, stores: { runs, flows } }) };
  };

  const runsOf = (buildId: string) =>
    db.prepare("SELECT id, status FROM runs WHERE build_id = ? ORDER BY rowid").all(buildId);

  const leaveRunning = (runs: SqliteStore, build: Seeded) =>
    runs.createRun({
      buildDir: build.dir,
      inputs: {},
      nodeIds: ["s1"],
      session: { tmuxName: "fd-left", cwd: build.worktree, claudeSessionId: "c0" },
      buildId: build.id,
    });

  it("is refused with exit 2 and starts nothing, leaving only the run already going", async () => {
    const { runs, deps, recorded, scripts, seed } = sqliteDeps([ok]);
    const x = await seed(flow([script("s1")], []));
    const left = leaveRunning(runs, x);

    expect(await runCli(["run", "x"], deps)).toBe(2);

    expect(recorded.stderr.join("\n")).toMatch(/running/);
    nothingStarted(recorded, scripts);
    expect(runsOf(x.id)).toEqual([{ id: left.id, status: "running" }]);
  });

  it("does not hold back a different build, which runs side by side", async () => {
    const { runs, deps, scripts, seed } = sqliteDeps([ok]);
    const x = await seed(flow([script("s1")], []), { name: "x" });
    const y = await seed(flow([script("s1")], []), { name: "y" });
    leaveRunning(runs, x);

    expect(await runCli(["run", "y"], deps)).toBe(0);

    expect(scripts.calls.map((call) => call.cwd)).toEqual([y.worktree]);
    expect(runsOf(y.id)).toEqual([{ id: expect.any(String), status: "done" }]);
  });

  it("refuses a run of a deleted build named by its id with exit 2, and records no run", async () => {
    const { runs, deps, recorded, scripts, seed } = sqliteDeps([ok]);
    const x = await seed(flow([script("s1")], []));
    runs.deleteBuild(x.id);

    expect(await runCli(["run", x.id], deps)).toBe(2);

    expect(recorded.stderr.join("\n")).toContain("was deleted");
    nothingStarted(recorded, scripts);
    expect(runsOf(x.id)).toEqual([]);
  });

  it("runs again once the run going has been stopped", async () => {
    const { runs, deps, seed } = sqliteDeps([ok]);
    const x = await seed(flow([script("s1")], []));
    const left = leaveRunning(runs, x);
    runs.stopRun(left.id);

    expect(await runCli(["run", "x"], deps)).toBe(0);
    expect(runsOf(x.id)).toHaveLength(2);
  });
});

describe("runCli and old builds", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase({ path: join(home, "flowdeck.db") });
  });

  afterEach(() => {
    db.close();
  });

  const step = (id: string) => ({ id, type: "script", label: id, settings: { command: id } });

  async function oldBuild() {
    const manifestWithoutHash = {
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
        { id: "t", type: "trigger", label: "t", settings: { inputs: [], flags: { e2e: true } } },
        step("s0"),
        { id: "b", type: "branch", label: "b", settings: { flag: "e2e" } },
        step("e2e"),
        step("quick"),
        step("finish"),
      ],
      wires: [
        thenWire("t", "s0"),
        thenWire("s0", "b"),
        wire("b", "yes", "e2e", "in"),
        wire("b", "no", "quick", "in"),
        thenWire("e2e", "finish"),
        thenWire("quick", "finish"),
      ],
      files: {},
    };
    const hash = hashBuild([
      { path: "manifest.json", content: canonicalJson(manifestWithoutHash) },
    ]);
    const dir = join(home, "builds", hash);
    const fs = new NodeFileSystem();
    await fs.writeFile(join(dir, "manifest.json"), canonicalJson({ ...manifestWithoutHash, hash }));
    db.prepare("INSERT INTO builds (id, hash, dir, created_at) VALUES (?, ?, ?, ?)").run(
      hash,
      hash,
      dir,
      1,
    );
    return { hash, dir };
  }

  const sqliteDeps = (results: ProcessResult[] = []) => {
    const runs = new SqliteStore({ db });
    return { runs, ...stubDeps({ results, stores: { runs, flows: new SqliteFlowStore({ db }) } }) };
  };

  it("refuses to start a run of an old build, pointing at a new build, and records no run", async () => {
    const { hash } = await oldBuild();
    const { deps, recorded, scripts } = sqliteDeps([ok, ok, ok, ok]);

    expect(await runCli(["run", hash], deps)).toBe(2);

    expect(recorded.stderr.join("\n")).toContain("Make a new build from this blueprint");
    nothingStarted(recorded, scripts);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  it("resumes a run of an old build, reapplying the flag stored on the run", async () => {
    const { hash, dir } = await oldBuild();
    const { runs, deps, scripts } = sqliteDeps([ok, ok]);
    const { id } = runs.createRun({
      buildDir: dir,
      inputs: { e2e: false },
      nodeIds: ["t", "s0", "b", "e2e", "quick", "finish"],
      session: { tmuxName: "fd-a", cwd: repo.path, claudeSessionId: "c1" },
      buildId: hash,
    });
    runs.append(id, "s0", { kind: "running" });
    runs.append(id, "s0", { kind: "done" });

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(scripts.calls.map((call) => [call.command, call.cwd])).toEqual([
      ["quick", repo.path],
      ["finish", repo.path],
    ]);
    expect(runs.findRun(id)?.status).toBe("done");
  });
});

describe("runCli interrupted", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  }

  async function interruptibleDeps(input: Flow, scriptRun: Promise<ProcessResult>) {
    const stub = stubDeps({ connectors: new FakeConnectorSource() });
    const built = await stub.seed(input);
    const log: string[] = [];
    const start = deferred<undefined>();
    let interrupt: (code: number) => void = () => undefined;
    const deps: CliDeps = {
      ...stub.deps,
      stdout: (line) => {
        log.push(`line ${line}`);
      },
      stderr: () => undefined,
      scripts: {
        run: () => {
          log.push("script run");
          interrupt(130);
          return scriptRun;
        },
      },
      startEvents: async () => ({
        events: new FakeEventSource(),
        stop: async () => {
          log.push("events stopped");
        },
      }),
      openSession: async () => ({
        sessionId,
        session: {
          ensureStarted: async () => {
            log.push("start requested");
            interrupt(130);
            await start.promise;
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
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => (interrupt = () => undefined);
      },
    };
    return { deps, built, log, start, store: stub.store };
  }

  it("never starts Claude for a prompt reached after the run was stopped", async () => {
    const blocked = deferred<ProcessResult>();
    const { deps, log } = await interruptibleDeps(
      flow([shScript("s1"), prompt("p1")], [thenWire("s1", "p1")]),
      blocked.promise,
    );

    expect(await runCli(["run", "x"], deps)).toBe(130);
    blocked.resolve(ok);
    await settle();

    expect(log).not.toContain("start requested");
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual([]);
  });

  it("never runs a script reached after the run was stopped", async () => {
    const blocked = deferred<ProcessResult>();
    const { deps, log } = await interruptibleDeps(
      flow([shScript("s1"), shScript("s2")], [thenWire("s1", "s2")]),
      blocked.promise,
    );

    expect(await runCli(["run", "x"], deps)).toBe(130);
    blocked.resolve(ok);
    await settle();

    expect(log.filter((entry) => entry === "script run")).toHaveLength(1);
  });

  it("stops a session whose start finishes after the run was stopped, and sends nothing", async () => {
    const { deps, log, start } = await interruptibleDeps(
      flow([prompt("p1")], []),
      Promise.resolve(ok),
    );

    expect(await runCli(["run", "x"], deps)).toBe(130);
    start.resolve(undefined);
    await settle();

    expect(log.slice(log.indexOf("started"))).toContain("session stopped");
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual([]);
  });

  it("records the run as stopped when interrupted", async () => {
    const blocked = deferred<ProcessResult>();
    const { deps, store } = await interruptibleDeps(
      flow([shScript("s1"), shScript("s2")], [thenWire("s1", "s2")]),
      blocked.promise,
    );

    expect(await runCli(["run", "x"], deps)).toBe(130);
    blocked.resolve(ok);
    await settle();

    expect(store.runs[0]?.status).toBe("stopped");
  });

  it("stops the attached session when a resume is interrupted", async () => {
    const { deps, built, log, store, start } = await interruptibleDeps(
      flow([prompt("p1"), prompt("p2")], [thenWire("p1", "p2")]),
      Promise.resolve(ok),
    );
    const { id } = store.createRun({
      buildDir: built.dir,
      inputs: {},
      nodeIds: ["p1", "p2"],
      session: { tmuxName: "fd-a", cwd: built.worktree, claudeSessionId: "c1" },
      buildId: built.id,
    });
    store.append(id, "p1", { kind: "sent" });

    expect(await runCli(["resume", id], deps)).toBe(130);
    start.resolve(undefined);
    await settle();

    expect(log).toContain("session stopped");
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual([]);
    expect(store.runs[0]?.status).toBe("stopped");
  });
});

describe("runCli build", () => {
  const writeFlow = async (input: unknown, name = "flow.json") => {
    const path = join(home, name);
    await writeFile(path, JSON.stringify(input));
    return path;
  };

  const printed = (stdout: string[]) => {
    const hash = stdout.find((line) => line.startsWith("hash "))?.slice(5) ?? "";
    const dir = stdout.find((line) => line.startsWith("dir "))?.slice(4) ?? "";
    return { hash, dir, id: basename(dir) };
  };

  const workspaces = async () => readdir(join(home, "workspaces")).catch(() => []);

  it("builds a flow file under the name given, into its own workspace and worktree", async () => {
    const flowPath = await writeFlow(promptThenScript());
    const { deps, recorded, store } = stubDeps();

    expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(0);

    const { hash, dir, id } = printed(recorded.stdout);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dir).toBe(join(home, "workspaces", id));
    expect(await exists(join(dir, "manifest.json"))).toBe(true);
    const worktree = join(dir, basename(repo.path));
    expect(await toplevelOf(worktree)).toBe(await realpath(worktree));
    expect(await branchOf(worktree)).toBe(`flowdeck/x-${id.slice(0, 8)}`);
    expect(store.findBuildByName("x")).toMatchObject({
      id,
      hash,
      name: "x",
      repo: repo.path,
      base: "main",
      values: {},
      dir,
    });
    expect(store.findBuildByName("x")?.source).toBeUndefined();
    expect(recorded.storePaths).toEqual([join(home, "flowdeck.db")]);
  });

  it("builds a saved flow version under the name given and records that version", async () => {
    const flows = new FakeFlowStore({ newId: () => "flow-1" });
    flows.save(flow([prompt("p1")], []));
    flows.save(promptThenScript());
    const store = new FakeStore();
    const { deps, recorded } = stubDeps({ stores: { runs: store, flows } });

    expect(
      await runCli(
        ["build", "--flow", "flow-1", "--version", "2", "--name", "x", "--repo", repo.path],
        deps,
      ),
    ).toBe(0);

    const { dir, id } = printed(recorded.stdout);
    expect(dir).toBe(join(home, "workspaces", id));
    expect(store.findBuildByName("x")?.source).toEqual({ flowId: "flow-1", version: 2 });
  });

  it("records the --base given", async () => {
    await git("git", ["-C", repo.path, "branch", "dev"]);
    const flowPath = await writeFlow(promptThenScript());
    const { deps, store } = stubDeps();

    expect(
      await runCli(["build", flowPath, "--name", "x", "--repo", repo.path, "--base", "dev"], deps),
    ).toBe(0);
    expect(store.findBuildByName("x")?.base).toBe("dev");
  });

  it("takes the repo's default branch as the base when neither --base nor the blueprint names one", async () => {
    await git("git", ["-C", repo.path, "checkout", "--quiet", "-b", "trunk"]);
    const flowPath = await writeFlow(withConfig(promptThenScript(), { base: null }));
    const { deps, store } = stubDeps();

    expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(0);
    expect(store.findBuildByName("x")?.base).toBe("trunk");
  });

  describe("--var", () => {
    const declared = withConfig(promptThenScript(), {
      variables: [
        { name: "ticket", kind: "text" },
        { name: "query", kind: "text", default: "none" },
        { name: "e2e", kind: "yesno" },
      ],
    });

    const buildWith = async (vars: string[]) => {
      const flowPath = await writeFlow(declared);
      const stub = stubDeps();
      const code = await runCli(
        [
          "build",
          flowPath,
          "--name",
          "x",
          "--repo",
          repo.path,
          ...vars.flatMap((v) => ["--var", v]),
        ],
        stub.deps,
      );
      return { code, ...stub };
    };

    it.each([
      [["ticket=FD-1", "e2e=yes"], { ticket: "FD-1", query: "none", e2e: true }],
      [["ticket=FD-1", "e2e=no", "query=a=b"], { ticket: "FD-1", query: "a=b", e2e: false }],
    ])("records the values of %j", async (vars, values) => {
      const { code, store } = await buildWith(vars);

      expect(code).toBe(0);
      expect(store.findBuildByName("x")?.values).toEqual(values);
    });

    it("refuses a yes/no value other than yes or no, naming the variable, and builds nothing", async () => {
      const { code, recorded, store } = await buildWith(["ticket=FD-1", "e2e=maybe"]);

      expect(code).toBe(2);
      expect(recorded.stderr.join("\n")).toContain("e2e");
      expect(store.listBuilds()).toEqual([]);
      expect(await workspaces()).toEqual([]);
    });

    it("refuses a build that leaves a variable unset, naming it, and builds nothing", async () => {
      const { code, recorded, store } = await buildWith(["e2e=yes"]);

      expect(code).toBe(2);
      expect(recorded.stderr.join("\n")).toContain("ticket");
      expect(store.listBuilds()).toEqual([]);
      expect(await workspaces()).toEqual([]);
    });

    it("refuses a --var the blueprint does not declare, naming it and every declared one, and builds nothing", async () => {
      const { code, recorded, store } = await buildWith(["ticket=FD-1", "e2e=yes", "tikcet=FD-2"]);

      expect(code).toBe(2);
      const stderr = recorded.stderr.join("\n");
      expect(stderr).toContain("tikcet");
      for (const name of ["ticket", "query", "e2e"]) expect(stderr).toContain(name);
      expect(store.listBuilds()).toEqual([]);
      expect(await workspaces()).toEqual([]);
    });

    it("refuses a --var with no = as a usage error", async () => {
      const { code, recorded, store } = await buildWith(["ticket", "e2e=yes"]);

      expect(code).toBe(2);
      expect(recorded.stderr.join("\n")).toContain("Usage:");
      expect(store.listBuilds()).toEqual([]);
    });
  });

  it("refuses a name that is not kebab-case, naming it, and builds nothing", async () => {
    const flowPath = await writeFlow(promptThenScript());
    const { deps, recorded, store } = stubDeps();

    expect(
      await runCli(["build", flowPath, "--name", "Fix-Login", "--repo", repo.path], deps),
    ).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("Fix-Login");
    expect(store.listBuilds()).toEqual([]);
    expect(await workspaces()).toEqual([]);
  });

  it("refuses a target that is not a git repository, naming it, and builds nothing", async () => {
    const plain = await mkdtemp(join(tmpdir(), "fd-plain-"));
    try {
      const flowPath = await writeFlow(promptThenScript());
      const { deps, recorded, store } = stubDeps();

      expect(await runCli(["build", flowPath, "--name", "x", "--repo", plain], deps)).toBe(2);
      expect(recorded.stderr.join("\n")).toContain(plain);
      expect(store.listBuilds()).toEqual([]);
      expect(await workspaces()).toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("refuses a name an existing build already has, naming it", async () => {
    const flowPath = await writeFlow(promptThenScript());
    const { deps, recorded, store } = stubDeps();
    expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(0);

    expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("x already exists");
    expect(store.listBuilds()).toHaveLength(1);
  });

  it.each([
    [
      ["build", "--flow", "flow-1", "--version", "9", "--name", "x"],
      "flow-1 has no saved version 9",
    ],
    [["build", "--flow", "flow-1", "--version", "two", "--name", "x"], "Usage:"],
    [["build", "--flow", "flow-1", "--name", "x"], "Usage:"],
    [["build", "--flow", "flow-1", "--version", "1"], "Usage:"],
    [["build", "f.json", "--flow", "flow-1", "--version", "1", "--name", "x"], "Usage:"],
    [["build", "f.json"], "Usage:"],
  ])("refuses %j with exit 2", async (argv, message) => {
    const flows = new FakeFlowStore({ newId: () => "flow-1" });
    flows.save(promptThenScript());
    const store = new FakeStore();
    const { deps, recorded } = stubDeps({ stores: { runs: store, flows } });

    expect(await runCli(argv, deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain(message);
    expect(store.listBuilds()).toEqual([]);
  });

  it("shows --name, --repo, --base and --var in the build usage", async () => {
    const { deps, recorded } = stubDeps();

    await runCli(["build"], deps);

    const usage = recorded.stderr.join("\n");
    for (const option of ["--name", "--repo", "--base", "--var"]) {
      expect(usage).toContain(option);
    }
  });

  it("looks up the flow's connectors when it builds, and refuses one Claude Code lacks", async () => {
    const flowPath = await writeFlow(
      withConfig(promptThenScript(), { connectors: ["jira", "slack"] }),
    );
    const { deps, recorded, store } = stubDeps();

    expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(2);
    expect(recorded.stderr).toEqual([
      expect.stringMatching(/^connectors: Connector "slack" is not set up in Claude Code/),
    ]);
    expect(store.listBuilds()).toEqual([]);
  });

  it.each([
    ["an empty body", flow([prompt("p1"), loop("l1")], [thenWire("p1", "l1")])],
    [
      "a Script-only body",
      flow([loop("l1"), script("s1", { parent: "l1" })], [thenWire("l1", "s1")]),
    ],
  ])(
    "refuses to build a loop with %s, the same way the runner refuses it",
    async (_name, input) => {
      const flowPath = await writeFlow(input);
      const { deps, recorded, store } = stubDeps();

      expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(2);
      expect(recorded.stderr).toEqual(["loop-body: l1 (loop) has no prompt or agent in its body."]);
      expect(store.listBuilds()).toEqual([]);
    },
  );

  it("prints each problem of an invalid flow and exits 2", async () => {
    const broken = fileURLToPath(new URL("../fixtures/broken/references.json", import.meta.url));
    const { deps, recorded } = stubDeps();

    expect(await runCli(["build", broken, "--name", "x", "--repo", repo.path], deps)).toBe(2);
    expect(recorded.stderr.length).toBeGreaterThan(0);
    expect(recorded.stderr.join("\n")).toContain("references");
    expect(recorded.stdout).toEqual([]);
  });

  it("leaves a run of a built version that joins in SQL to its build and flow version", async () => {
    const db = openDatabase({ path: join(home, "flowdeck.db") });
    try {
      const sqlFlows = new SqliteFlowStore({ db, newId: () => "flow-sql" });
      sqlFlows.save(flow([shScript("s1")], []));
      const { deps, recorded } = stubDeps({
        results: [ok],
        stores: { runs: new SqliteStore({ db }), flows: sqlFlows },
      });

      expect(
        await runCli(
          ["build", "--flow", "flow-sql", "--version", "1", "--name", "x", "--repo", repo.path],
          deps,
        ),
      ).toBe(0);
      const builtDir = printed(recorded.stdout).dir;
      expect(await runCli(["run", "x"], deps)).toBe(0);

      const runId = recorded.stderr.find((line) => line.startsWith("run "))?.slice(4);
      expect(
        db
          .prepare(
            `SELECT flows.id AS flow, flow_versions.version, builds.dir, builds.name, build_nodes.type
               FROM runs
               JOIN builds ON builds.id = runs.build_id
               JOIN flow_versions ON flow_versions.flow_id = builds.flow_id
                                 AND flow_versions.version = builds.version
               JOIN flows ON flows.id = flow_versions.flow_id
               JOIN run_nodes ON run_nodes.run_id = runs.id
               JOIN build_nodes ON build_nodes.build_id = builds.id
                               AND build_nodes.node_id = run_nodes.node_id
              WHERE runs.id = ?`,
          )
          .all(runId),
      ).toEqual([{ flow: "flow-sql", version: 1, dir: builtDir, name: "x", type: "script" }]);
    } finally {
      db.close();
    }
  });

  it("builds with --name, --repo and --var, then runs that build by name in its worktree", async () => {
    const db = openDatabase({ path: join(home, "flowdeck.db") });
    try {
      const flowPath = await writeFlow(
        withConfig(flow([script("s1")], []), { variables: [{ name: "ticket", kind: "text" }] }),
      );
      const runs = new SqliteStore({ db });
      const { deps, recorded, scripts } = stubDeps({
        results: [ok],
        stores: { runs, flows: new SqliteFlowStore({ db }) },
      });

      expect(
        await runCli(
          ["build", flowPath, "--name", "x", "--repo", repo.path, "--var", "ticket=FD-1"],
          deps,
        ),
      ).toBe(0);
      expect(await runCli(["run", "x"], deps)).toBe(0);

      const { dir, id } = printed(recorded.stdout);
      const worktree = join(dir, basename(repo.path));
      expect(scripts.calls.map((call) => call.cwd)).toEqual([worktree]);
      expect(await branchOf(worktree)).toBe(`flowdeck/x-${id.slice(0, 8)}`);
      expect(runs.findBuildByName("x")?.values).toEqual({ ticket: "FD-1" });
      expect(runs.listRuns().map((run) => run.buildId)).toEqual([id]);
    } finally {
      db.close();
    }
  });

  describe("build agents", () => {
    const withAgents = (deps: CliDeps) => {
      const agents = new FakeBuildAgents({ fs: deps.fs });
      return { deps: { ...deps, build: { ...deps.build, agents } }, agents };
    };

    const progressLines = (stdout: string[]) =>
      stdout.filter((line) => line.startsWith("Building · ") || line.startsWith("Built · "));

    const fileHashes = async (dir: string): Promise<Record<string, string>> => {
      const hashes: Record<string, string> = {};
      for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        hashes[path] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
      return hashes;
    };

    it("prints one line per step and ends with Built · v1", async () => {
      const flowPath = await writeFlow(promptThenScript());
      const { deps, recorded } = stubDeps();

      expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(0);

      expect(progressLines(recorded.stdout)).toEqual([
        "Building · step 1 of 5",
        "Building · step 2 of 5",
        "Building · step 3 of 5",
        "Building · step 4 of 5",
        "Building · step 5 of 5",
        "Built · v1",
      ]);
    });

    it("opens the build session with the --build-model given", async () => {
      const flowPath = await writeFlow(promptThenScript());
      const { deps, agents } = withAgents(stubDeps().deps);

      expect(
        await runCli(
          ["build", flowPath, "--name", "x", "--repo", repo.path, "--build-model", "haiku"],
          deps,
        ),
      ).toBe(0);

      expect(agents.opened.map((spec) => spec.model)).toEqual(["haiku"]);
    });

    describe("interrupted", () => {
      const interruptible = (deps: CliDeps) => {
        let interrupt: (code: number) => void = () => undefined;
        return {
          deps: {
            ...deps,
            onInterrupt: (handler: (code: number) => void) => {
              interrupt = handler;
              return () => (interrupt = () => undefined);
            },
          },
          interrupt: (code: number) => interrupt(code),
        };
      };

      const exitCode = (flowPath: string, deps: CliDeps) =>
        Promise.race([
          runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps),
          new Promise((resolve) => setTimeout(() => resolve("still building"), 1000)),
        ]);

      const expectStopped = async (store: FakeStore, agents: FakeBuildAgents) => {
        expect(agents.closed).toEqual(["fd-build-TestKit1"]);
        expect(await workspaces()).toEqual([]);
        expect(await exists(join(home, "build-sessions", "fd-build-TestKit1"))).toBe(false);
        expect(store.listPendingBuilds()).toEqual([]);
        expect(store.listLatestEndedPendingBuilds()).toEqual([
          expect.objectContaining({ name: "x", outcome: "stopped" }),
        ]);
        expect(store.builds()).toEqual([]);
      };

      it("on Ctrl-C mid-turn closes the build session, removes its workspace, ends the build stopped and exits", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        const agents = {
          open: fake.open,
          turn: async () => {
            t.interrupt(130);
            return new Promise<never>(() => undefined);
          },
          alive: fake.alive,
          close: fake.close,
        };
        const deps = { ...t.deps, build: { ...t.deps.build, agents } };

        expect(await exitCode(flowPath, deps)).toBe(130);

        await expectStopped(stub.store, fake);
      });

      it("on Ctrl-C mid-turn exits with the interrupt's code and says why when closing the session fails", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        const agents = {
          open: fake.open,
          turn: async () => {
            t.interrupt(130);
            return new Promise<never>(() => undefined);
          },
          alive: fake.alive,
          close: () => Promise.reject(new Error("close failed")),
        };
        const deps = { ...t.deps, build: { ...t.deps.build, agents } };

        expect(await exitCode(flowPath, deps)).toBe(130);

        expect(stub.recorded.stderr.join("\n")).toContain("close failed");
        expect(stub.store.listPendingBuilds()).toEqual([]);
      });

      it("on Ctrl-C while the repo is still being read leaves no open build and no workspace", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const reads: string[] = [];
        const real = t.deps.gitState;
        const deps: CliDeps = {
          ...t.deps,
          build: { ...t.deps.build, agents: fake },
          gitState: {
            read: async (folder) => {
              reads.push(folder);
              t.interrupt(130);
              await held;
              return real.read(folder);
            },
            branches: (folder) => real.branches(folder),
            defaultBranch: (folder) => real.defaultBranch(folder),
          },
        };

        expect(await exitCode(flowPath, deps)).toBe(130);
        release();

        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          expect(stub.store.listPendingBuilds()).toEqual([]);
          expect(await workspaces()).toEqual([]);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(reads).toHaveLength(1);
        expect(fake.opened).toEqual([]);
        expect(await exists(join(home, "build-sessions", "fd-build-TestKit1"))).toBe(false);
        expect(stub.store.builds()).toEqual([]);
      });

      it("on Ctrl-C once the worktree is cut removes the worktree and its branch too", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        const worktrees = new GitWorktree();
        const cut: { path: string; branch: string }[] = [];
        const deps: CliDeps = {
          ...t.deps,
          build: { ...t.deps.build, agents: fake },
          worktree: {
            add: async (options) => {
              await worktrees.add(options);
              cut.push(options);
              t.interrupt(130);
            },
            remove: (options) => worktrees.remove(options),
            isDirty: (path) => worktrees.isDirty(path),
            hasUnpushed: (repoPath, branch, base) => worktrees.hasUnpushed(repoPath, branch, base),
            deleteBranch: (repoPath, branch) => worktrees.deleteBranch(repoPath, branch),
          },
        };

        expect(await exitCode(flowPath, deps)).toBe(130);

        expect(cut).toHaveLength(1);
        expect(await exists(cut[0]?.path ?? "")).toBe(false);
        const { stdout: branches } = await git("git", [
          "-C",
          repo.path,
          "branch",
          "--list",
          "--format=%(refname:short)",
        ]);
        expect(branches.split("\n")).not.toContain(cut[0]?.branch);
        await expectStopped(stub.store, fake);
      });

      it("on Ctrl-C during the worktree cut closes the build session once", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        const worktrees = new GitWorktree();
        let releaseAdd: () => void = () => undefined;
        const addGate = new Promise<void>((resolve) => {
          releaseAdd = resolve;
        });
        let releaseClose: () => void = () => undefined;
        const closeGate = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        const closing: string[] = [];
        const deps: CliDeps = {
          ...t.deps,
          build: {
            ...t.deps.build,
            agents: {
              open: fake.open,
              turn: fake.turn,
              alive: fake.alive,
              close: async (sessionName) => {
                closing.push(sessionName);
                if (closing.length === 1) await closeGate;
                return fake.close(sessionName);
              },
            },
          },
          worktree: {
            add: async (options) => {
              t.interrupt(130);
              await addGate;
              await worktrees.add(options);
            },
            remove: (options) => worktrees.remove(options),
            isDirty: (path) => worktrees.isDirty(path),
            hasUnpushed: (repoPath, branch, base) => worktrees.hasUnpushed(repoPath, branch, base),
            deleteBranch: (repoPath, branch) => worktrees.deleteBranch(repoPath, branch),
          },
        };

        const exited = exitCode(flowPath, deps);
        releaseAdd();
        await vi.waitFor(() => {
          expect(closing).toHaveLength(1);
        });
        releaseClose();

        expect(await exited).toBe(130);
        expect(closing).toEqual(["fd-build-TestKit1"]);
        expect(await workspaces()).toEqual([]);
        expect(stub.store.listPendingBuilds()).toEqual([]);
        expect(stub.store.listLatestEndedPendingBuilds()).toEqual([
          expect.objectContaining({ name: "x", outcome: "stopped" }),
        ]);
        expect(stub.store.builds()).toEqual([]);
      });

      it("on Ctrl-C while the build session opens sends no turn and closes the session before exiting", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        let releaseOpen: () => void = () => undefined;
        const openGate = new Promise<void>((resolve) => {
          releaseOpen = resolve;
        });
        const deps: CliDeps = {
          ...t.deps,
          build: {
            ...t.deps.build,
            agents: {
              open: async (spec) => {
                t.interrupt(130);
                await openGate;
                return fake.open(spec);
              },
              turn: fake.turn,
              alive: fake.alive,
              close: fake.close,
            },
          },
        };

        const exited = exitCode(flowPath, deps);
        setTimeout(releaseOpen, 100);

        expect(await exited).toBe(130);
        expect(fake.opened).toHaveLength(1);
        expect(fake.turns).toEqual([]);
        expect(fake.closed).toEqual(["fd-build-TestKit1"]);
        expect(await fake.alive("fd-build-TestKit1")).toBe(false);
        await expectStopped(stub.store, fake);
      });

      it("on Ctrl-C while the worktree is being cut exits only once it is removed with its branch", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        const worktrees = new GitWorktree();
        let releaseAdd: () => void = () => undefined;
        const addGate = new Promise<void>((resolve) => {
          releaseAdd = resolve;
        });
        const cut: { path: string; branch: string }[] = [];
        const deps: CliDeps = {
          ...t.deps,
          build: { ...t.deps.build, agents: fake },
          worktree: {
            add: async (options) => {
              t.interrupt(130);
              await addGate;
              await worktrees.add(options);
              cut.push(options);
            },
            remove: (options) => worktrees.remove(options),
            isDirty: (path) => worktrees.isDirty(path),
            hasUnpushed: (repoPath, branch, base) => worktrees.hasUnpushed(repoPath, branch, base),
            deleteBranch: (repoPath, branch) => worktrees.deleteBranch(repoPath, branch),
          },
        };

        const exited = exitCode(flowPath, deps);
        setTimeout(releaseAdd, 100);

        expect(await exited).toBe(130);
        expect(cut).toHaveLength(1);
        expect(await exists(cut[0]?.path ?? "")).toBe(false);
        const { stdout: branches } = await git("git", [
          "-C",
          repo.path,
          "branch",
          "--list",
          "--format=%(refname:short)",
        ]);
        expect(branches.split("\n")).not.toContain(cut[0]?.branch);
        await expectStopped(stub.store, fake);
      });

      it("on Ctrl-C once the build is recorded keeps it with its workspace, ends it built and exits 0", async () => {
        const flowPath = await writeFlow(promptThenScript());
        const stub = stubDeps();
        const fake = new FakeBuildAgents({ fs: stub.deps.fs });
        const t = interruptible(stub.deps);
        let releaseClose: () => void = () => undefined;
        const closeGate = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        const closing: string[] = [];
        const deps: CliDeps = {
          ...t.deps,
          build: {
            ...t.deps.build,
            agents: {
              open: fake.open,
              turn: fake.turn,
              alive: fake.alive,
              close: async (sessionName) => {
                closing.push(sessionName);
                if (closing.length === 1) {
                  t.interrupt(130);
                  await closeGate;
                }
                return fake.close(sessionName);
              },
            },
          },
        };

        const exited = exitCode(flowPath, deps);
        await vi.waitFor(() => {
          expect(closing).not.toEqual([]);
        });
        const [recorded] = stub.store.builds();
        if (recorded === undefined) throw new Error("the build was not recorded before Ctrl-C");
        releaseClose();

        expect(await exited).toBe(0);
        expect(stub.store.builds().map((build) => build.id)).toEqual([recorded.id]);
        expect(await workspaces()).toHaveLength(1);
        expect(stub.store.listPendingBuilds()).toEqual([]);
        expect(stub.store.listLatestEndedPendingBuilds()).toEqual([
          expect.objectContaining({ name: "x", outcome: "built" }),
        ]);
      });
    });

    it("never starts the build agents again when the build runs twice, and leaves its files unchanged", async () => {
      const flowPath = await writeFlow(promptThenScript());
      const stub = stubDeps({ results: [ok, ok] });
      const { deps, agents } = withAgents(stub.deps);

      expect(await runCli(["build", flowPath, "--name", "x", "--repo", repo.path], deps)).toBe(0);
      const { dir } = printed(stub.recorded.stdout);
      const built = await fileHashes(dir);
      expect(await runCli(["run", "x"], deps)).toBe(0);
      const afterRun1 = await fileHashes(dir);
      expect(await runCli(["run", "x"], deps)).toBe(0);
      const afterRun2 = await fileHashes(dir);

      expect(agents.opened).toHaveLength(1);
      expect(Object.keys(built).length).toBeGreaterThan(0);
      expect(afterRun1).toEqual(built);
      expect(afterRun2).toEqual(built);
    });
  });
});

describe("runCli run state", () => {
  it("prints the run id first on stderr and stores the run, its session and its build", async () => {
    const { deps, recorded, store, seed } = stubDeps({ results: [ok] });
    const { id, dir, worktree } = await seed(promptThenScript());

    expect(await runCli(["run", "x", "--session", "fd-a"], deps)).toBe(0);

    const [run] = store.runs;
    expect(store.runs).toHaveLength(1);
    expect(recorded.stderr[0]).toBe(`run ${run?.id}`);
    expect(recorded.stdout).toEqual(["p1 started", "p1 done", "s1 started", "s1 done"]);
    expect(run).toMatchObject({
      buildDir: dir,
      buildId: id,
      status: "done",
      session: {
        tmuxName: "fd-a",
        cwd: worktree,
        claudeSessionId: recorded.openSession[0]?.claudeSessionId,
      },
    });
    expect(store.nodes.map((node) => node.nodeId)).toEqual(["p1", "s1"]);
  });

  it("names the build it runs without recording it again", async () => {
    const { deps, store, seed } = stubDeps({ results: [ok] });
    const { id } = await seed(promptThenScript());

    expect(await runCli(["run", "x"], deps)).toBe(0);

    expect(store.builds().map((build) => build.id)).toEqual([id]);
    expect(store.runs[0]?.buildId).toBe(id);
  });

  it("opens the store at FLOWDECK_HOME/flowdeck.db", async () => {
    const { deps, recorded, seed } = stubDeps({ results: [ok] });
    await seed(promptThenScript());

    await runCli(["run", "x"], deps);

    expect(recorded.storePaths).toEqual([join(home, "flowdeck.db")]);
  });

  it("records a run that ends at a failed node as failed", async () => {
    const { deps, store, seed } = stubDeps({ results: [failed] });
    await seed(promptThenScript());

    expect(await runCli(["run", "x"], deps)).toBe(1);
    expect(store.runs[0]?.status).toBe("failed");
  });
});

describe("runCli resume", () => {
  const nodeIds = ["p1", "p2", "p3"];
  const threePrompts = () =>
    flow([prompt("p1"), prompt("p2"), prompt("p3")], [thenWire("p1", "p2"), thenWire("p2", "p3")]);

  const turn = (id: string, ended: boolean, lastAssistantText?: string): TranscriptTurn => ({
    userText: `<command-name>/x:${id}</command-name>`,
    ended,
    ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
  });

  function seedRun(
    store: FakeStore,
    built: Seeded,
    events: [string, RunEvent][],
    options: { ids?: string[]; inputs?: Record<string, unknown> } = {},
  ) {
    const { id } = store.createRun({
      buildDir: built.dir,
      inputs: options.inputs ?? {},
      nodeIds: options.ids ?? nodeIds,
      session: { tmuxName: "fd-a", cwd: built.worktree, claudeSessionId: "c1" },
      buildId: built.id,
    });
    for (const [nodeId, event] of events) store.append(id, nodeId, event);
    return id;
  }

  const killedAtP2: [string, RunEvent][] = [
    ["p1", { kind: "sent" }],
    ["p1", { kind: "done" }],
    ["p2", { kind: "sent" }],
  ];

  it("refuses an unknown run id without touching tmux", async () => {
    const { deps, recorded, scripts } = stubDeps();

    expect(await runCli(["resume", "nope"], deps)).toBe(1);
    expect(recorded.stderr).toEqual(["no run nope"]);
    nothingStarted(recorded, scripts);
  });

  it("sends nothing for a run that already finished", async () => {
    const { deps, recorded, store, scripts, seed } = stubDeps();
    const id = seedRun(store, await seed(threePrompts()), []);
    store.finishRun(id, "done");

    expect(await runCli(["resume", id], deps)).toBe(0);
    expect(recorded.stderr).toEqual([`run ${id} already done`]);
    expect(recorded.sends).toEqual([]);
    expect(store.events(id)).toEqual([]);
    nothingStarted(recorded, scripts);
  });

  it("exits 1 naming the session when its tmux session is gone, starting and sending nothing", async () => {
    const { deps, recorded, store, seed } = stubDeps({ sessionGone: true });
    const id = seedRun(store, await seed(threePrompts()), killedAtP2);

    expect(await runCli(["resume", id], deps)).toBe(1);
    expect(recorded.stderr.join("\n")).toContain('"fd-a" is gone');
    expect(recorded.startEvents).toEqual([]);
    expect(recorded.sends).toEqual([]);
    expect(store.events(id)).toHaveLength(killedAtP2.length);
  });

  it("rewrites the run's private MCP config on resume", async () => {
    const { deps, recorded, store, seed } = stubDeps({ turns: [turn("p1", true, "A")] });
    const built = await seed(
      withConfig(flow([prompt("p1"), prompt("p2")], [thenWire("p1", "p2")]), {
        connectors: ["jira"],
      }),
    );
    const id = seedRun(store, built, [], { ids: ["p1", "p2"] });
    const runtimePath = join(home, "runs", id, "mcp.json");
    await deps.fs.writeFile(runtimePath, "stale");

    await runCli(["resume", id], deps);

    expect(recorded.openSession[0]?.mcpConfigPath).toBe(runtimePath);
    expect(await isPrivate(runtimePath)).toBe(true);
    expect(JSON.parse(await deps.fs.readFile(runtimePath))).toEqual({ mcpServers: { jira } });
  });

  it("listens before reading the transcript, completes node 2 without sending it and sends node 3 once", async () => {
    const { deps, recorded, store, seed } = stubDeps({
      turns: [turn("p1", true, "A"), turn("p2", true, "X")],
    });
    const built = await seed(threePrompts());
    const id = seedRun(store, built, killedAtP2);

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(recorded.order).toEqual(["listen", "transcript c1"]);
    expect(recorded.openSession).toEqual([
      {
        sessionName: "fd-a",
        buildDir: built.dir,
        layout: "workspace",
        model: "sonnet",
        socketPath: join(home, "sockets", "fd-a.sock"),
        cwd: built.worktree,
        claudeSessionId: "c1",
        hooks,
        attach: true,
      },
    ]);
    expect(recorded.sends).toEqual(["/x:p3 NODE p3"]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
    expect(store.findRun(id)?.status).toBe("done");
    expect(recorded.sessionStops).toBe(1);
    expect(recorded.eventStops).toBe(1);
  });

  it("reads the transcript again when node 2's Stop arrives during the read, completing it without a send", async () => {
    const { deps, recorded, store, source, seed } = stubDeps();
    const id = seedRun(store, await seed(threePrompts()), killedAtP2);
    const reads = [
      () => {
        source.publish({ kind: "Stop", sessionId, payload: {} });
        return [turn("p1", true, "A"), turn("p2", false)];
      },
      () => [turn("p1", true, "A"), turn("p2", true, "X")],
    ];
    let read = 0;
    deps.transcriptTurns = async () => reads[read++]?.() ?? [];

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(read).toBe(2);
    expect(recorded.sends).toEqual(["/x:p3 NODE p3"]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
  });

  it("does not settle node 3 with node 2's Stop arriving after the read showed node 2 ended", async () => {
    const { deps, recorded, store, source, seed } = stubDeps();
    const id = seedRun(store, await seed(threePrompts()), killedAtP2);
    let clock = 1;
    deps.now = () => clock;
    deps.transcriptTurns = async () => {
      const hookAt = clock;
      setTimeout(() => {
        source.publish({
          kind: "Stop",
          sessionId,
          payload: { last_assistant_message: "X", flowdeck_hook_at: hookAt },
        });
      }, 0);
      clock = 2;
      return [turn("p1", true, "A"), turn("p2", true, "X")];
    };

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(recorded.sends).toEqual(["/x:p3 NODE p3"]);
    expect(store.events(id).filter((event) => event.nodeId === "p3")).not.toContainEqual(
      expect.objectContaining({ kind: "done", payload: { stopMessage: "X" } }),
    );
  });

  it("completes node 2 with the Stop seen during the first read when the re-read still shows it mid-turn", async () => {
    const { deps, recorded, store, source, seed } = stubDeps();
    const id = seedRun(store, await seed(threePrompts()), killedAtP2);
    const reads = [
      () => {
        source.publish({ kind: "Stop", sessionId, payload: { last_assistant_message: "X" } });
        return [turn("p1", true, "A"), turn("p2", false)];
      },
      () => [turn("p1", true, "A"), turn("p2", false)],
    ];
    let read = 0;
    deps.transcriptTurns = async () => reads[read++]?.() ?? [];

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(recorded.sends).toEqual(["/x:p3 NODE p3"]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
  });

  it("completes node 2 with its own Stop stamped before the wait was armed", async () => {
    const { deps, recorded, store, source, seed } = stubDeps();
    const id = seedRun(store, await seed(threePrompts()), killedAtP2);
    let clock = 1;
    deps.now = () => clock;
    deps.transcriptTurns = async () => {
      const hookAt = clock;
      setTimeout(() => {
        source.publish({
          kind: "Stop",
          sessionId,
          payload: { last_assistant_message: "X", flowdeck_hook_at: hookAt },
        });
      }, 0);
      clock = 2;
      return [turn("p1", true, "A"), turn("p2", false)];
    };

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(recorded.sends).toEqual(["/x:p3 NODE p3"]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
  });

  it("opens a new session lazily when the run never sent a Claude turn", async () => {
    const { deps, recorded, store, seed } = stubDeps();
    const id = seedRun(store, await seed(threePrompts()), []);

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(recorded.openSession[0]?.attach).toBeUndefined();
    expect(recorded.sends).toEqual(["/x:p1 NODE p1", "/x:p2 NODE p2", "/x:p3 NODE p3"]);
    expect(store.findRun(id)?.status).toBe("done");
  });

  it("exits 1 with nothing sent when the transcript disagrees with the stored events", async () => {
    const { deps, recorded, store, seed } = stubDeps({
      turns: [turn("p2", true, "X"), turn("p2", true, "Y")],
    });
    const id = seedRun(store, await seed(threePrompts()), killedAtP2);

    expect(await runCli(["resume", id], deps)).toBe(1);
    expect(recorded.stderr.join("\n")).toContain("cannot resume p2");
    expect(recorded.sends).toEqual([]);
    expect(store.findRun(id)?.status).toBe("failed");
  });

  const gateFlow = () =>
    flow(
      [script("s1"), gate("g1", { settings: { skippable: true } }), script("s2")],
      [thenWire("s1", "g1"), thenWire("g1", "s2")],
    );

  const scriptDone: [string, RunEvent][] = [
    ["s1", { kind: "running" }],
    ["s1", { kind: "done" }],
  ];

  it("passes --auto to the resumed run, so a skippable Gate is skipped without asking", async () => {
    const waiter = new FakeWaiter([]);
    const { deps, recorded, store, seed } = stubDeps({ results: [ok], waiter });
    const id = seedRun(store, await seed(gateFlow()), scriptDone, { ids: ["s1", "g1", "s2"] });

    expect(await runCli(["resume", id, "--auto"], deps)).toBe(0);
    expect(recorded.stdout).toEqual(["g1 skipped", "s2 started", "s2 done"]);
    expect(waiter.calls).toEqual([]);
  });

  describe("with automatic mode stored on the run", () => {
    const resumeAtGate = async (args: string[]) => {
      const waiter = new FakeWaiter([{ decision: "approve" }]);
      const { deps, recorded, store, seed } = stubDeps({ results: [ok], waiter });
      const id = seedRun(store, await seed(gateFlow()), scriptDone, {
        ids: ["s1", "g1", "s2"],
        inputs: { auto: true },
      });
      return { code: await runCli(["resume", id, ...args], deps), recorded, waiter };
    };

    it("keeps the run's automatic mode, so a skippable Gate is skipped without --auto", async () => {
      const { code, recorded, waiter } = await resumeAtGate([]);

      expect(code).toBe(0);
      expect(recorded.stdout).toEqual(["g1 skipped", "s2 started", "s2 done"]);
      expect(waiter.calls).toEqual([]);
    });

    it("lets --no-auto override the stored automatic mode, so the Gate asks", async () => {
      const { code, waiter } = await resumeAtGate(["--no-auto"]);

      expect(code).toBe(0);
      expect(waiter.calls.map((call) => call.nodeId)).toEqual(["g1"]);
    });
  });

  it("shows resume in the usage", async () => {
    const { deps, recorded } = stubDeps();

    expect(await runCli(["resume"], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("flowdeck resume <id> [--auto | --no-auto]");
  });
});

describe("runCli branch variables", () => {
  const step = (id: string) => script(id, { settings: { command: id } });
  const ran = (scripts: FakeProcessRunner) => scripts.calls.map((call) => call.command);
  const kindsOf = (store: FakeStore, runId: string, nodeId: string) =>
    store
      .events(runId)
      .filter((event) => event.nodeId === nodeId)
      .map((event) => event.kind);

  const branchFlow = (e2eDefault: boolean) =>
    flow(
      [
        trigger("t", { settings: { inputs: [], flags: { e2e: e2eDefault } } }),
        step("s0"),
        branch("b", "e2e"),
        step("e2e"),
        step("quick"),
        step("finish"),
      ],
      [
        thenWire("t", "s0"),
        thenWire("s0", "b"),
        wire("b", "yes", "e2e", "in"),
        wire("b", "no", "quick", "in"),
        thenWire("e2e", "finish"),
        thenWire("quick", "finish"),
      ],
    );

  it.each([
    [true, {}, ["s0", "e2e", "finish"], "quick"],
    [true, { e2e: false }, ["s0", "quick", "finish"], "e2e"],
    [false, { e2e: true }, ["s0", "e2e", "finish"], "quick"],
  ] as const)(
    "with the default %s and the build's values %j, runs %j and skips %s",
    async (e2eDefault, values, expected, skipped) => {
      const { deps, scripts, store, seed } = stubDeps({ results: [ok, ok, ok, ok] });
      await seed(branchFlow(e2eDefault), { values });

      expect(await runCli(["run", "x"], deps)).toBe(0);
      expect(ran(scripts)).toEqual(expected);
      expect(kindsOf(store, store.runs[0]?.id ?? "", skipped)).toEqual(["skipped"]);
    },
  );

  it("takes the build's value on resume, so the path the build chose still runs", async () => {
    const { deps, scripts, store, seed } = stubDeps({ results: [ok, ok, ok] });
    const built = await seed(branchFlow(true), { values: { e2e: false } });
    const { id } = store.createRun({
      buildDir: built.dir,
      inputs: {},
      nodeIds: ["t", "s0", "b", "e2e", "quick", "finish"],
      session: { tmuxName: "fd-a", cwd: built.worktree, claudeSessionId: "c1" },
      buildId: built.id,
    });
    store.append(id, "s0", { kind: "running" });
    store.append(id, "s0", { kind: "done" });

    expect(await runCli(["resume", id], deps)).toBe(0);
    expect(ran(scripts)).toEqual(["quick", "finish"]);
    expect(kindsOf(store, id, "e2e")).toEqual(["skipped"]);
  });
});
