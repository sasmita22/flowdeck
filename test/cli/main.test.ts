import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../src/adapters/process/process-runner.js";
import { SessionGoneError } from "../../src/adapters/claude/claude-session.js";
import { runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import type { Flow } from "../../src/core/flow/schema.js";
import type { TranscriptTurn } from "../../src/core/run/resume.js";
import type { RunEvent } from "../../src/core/run/run-events.js";
import type { ProcessResult } from "../../src/ports/process-runner.js";
import type { WaitReply } from "../../src/ports/waiter.js";
import { FakeEventSource } from "../fakes/fake-event-source.js";
import { FakeFileSystem } from "../fakes/fake-file-system.js";
import { FakeProcessRunner } from "../fakes/fake-process-runner.js";
import { FakeStore } from "../fakes/fake-store.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import {
  agent,
  ask,
  flow,
  gate,
  loop,
  output,
  prompt,
  script,
  thenWire,
  trigger,
} from "../fixtures/flow-builders.js";

const shScript = (id: string) => script(id, { settings: { command: "sh" } });

const home = "/fd-home";
const repo = "/repo";
const sessionId = "s1";
const hooks = { nodePath: "/n", hookScriptPath: "/h" };
const ok: ProcessResult = { code: 0, stdout: "", stderr: "" };

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
  fs: CliDeps["fs"],
  options: {
    env?: Record<string, string>;
    results?: ProcessResult[];
    subagents?: string[];
    waiter?: FakeWaiter;
    turns?: TranscriptTurn[];
    sessionGone?: boolean;
  } = {},
) {
  const source = new FakeEventSource();
  const store = new FakeStore();
  const scripts = new FakeProcessRunner(options.results ?? []);
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
    waiter: options.waiter ?? new FakeWaiter([]),
    openStore: (path) => {
      recorded.storePaths.push(path);
      return store;
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
          sendPrompt: async (text) => {
            recorded.sends.push(text);
            setTimeout(() => {
              for (const agentType of options.subagents ?? []) {
                source.publish({
                  kind: "SubagentStop",
                  sessionId,
                  payload: { agent_type: agentType },
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
  return { deps, recorded, scripts, store, source };
}

async function built(fs: FakeFileSystem, input: Flow): Promise<{ dir: string; hash: string }> {
  const result = await build(input, { fs, home, hooks });
  if (!result.ok) throw new Error("build failed");
  return result;
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
  let fs: FakeFileSystem;
  let dir: string;
  let hash: string;

  beforeEach(async () => {
    fs = new FakeFileSystem();
    ({ dir, hash } = await built(fs, promptThenScript()));
  });

  it.each([
    [[]],
    [["launch"]],
    [["run"]],
    [["run", "/fd-home/builds/x"]],
    [["run", "--cwd", repo]],
    [["run", "/fd-home/builds/x", "--cwd", repo, "--colour"]],
  ])("refuses the arguments %j with usage and exit 2", async (argv) => {
    const { deps, recorded, scripts } = stubDeps(fs);

    expect(await runCli(argv, deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("Usage:");
    nothingStarted(recorded, scripts);
  });

  it("refuses a session name outside fd-", async () => {
    const { deps, recorded, scripts } = stubDeps(fs);

    expect(await runCli(["run", dir, "--cwd", repo, "--session", "mine"], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("mine");
    nothingStarted(recorded, scripts);
  });

  it("names the session fd-run-<short id> by default", async () => {
    const { deps, recorded } = stubDeps(fs, { results: [ok] });

    await runCli(["run", dir, "--cwd", repo], deps);

    expect(recorded.openSession[0]?.sessionName).toMatch(/^fd-run-[0-9a-f]{8}$/);
  });

  it("refuses a hook socket path longer than the platform limit", async () => {
    const longHome = `/${"h".repeat(120)}`;
    const { deps, recorded, scripts } = stubDeps(fs, { env: { FLOWDECK_HOME: longHome } });

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("longer than 104");
    nothingStarted(recorded, scripts);
  });

  it("puts the hook socket under ~/.flowdeck when FLOWDECK_HOME is unset", async () => {
    const { deps, recorded } = stubDeps(fs, { env: {}, results: [ok] });

    await runCli(["run", dir, "--cwd", repo, "--session", "fd-x"], deps);

    expect(recorded.startEvents).toEqual([join(homedir(), ".flowdeck", "sockets", "fd-x.sock")]);
  });

  it("refuses a tampered build before starting anything, printing each problem", async () => {
    await fs.writeFile(`${dir}/commands/p1.md`, "tampered\n");
    await fs.writeFile(`${dir}/extra.md`, "extra\n");
    const { deps, recorded, scripts } = stubDeps(fs);

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(2);
    expect(recorded.stderr).toEqual(
      expect.arrayContaining([
        expect.stringContaining("commands/p1.md: changed"),
        expect.stringContaining("extra.md: extra"),
      ]),
    );
    expect(recorded.stdout).toEqual([]);
    nothingStarted(recorded, scripts);
  });

  it("refuses a loop with an empty body before starting anything", async () => {
    const other = new FakeFileSystem();
    const { dir: loopDir } = await built(
      other,
      flow([prompt("p1"), loop("l1")], [thenWire("p1", "l1")]),
    );
    const { deps, recorded, scripts } = stubDeps(other);

    expect(await runCli(["run", loopDir, "--cwd", repo], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("l1 (loop) has no prompt or agent in its body");
    nothingStarted(recorded, scripts);
  });

  it("refuses a loop whose body is a Script only, running nothing", async () => {
    const other = new FakeFileSystem();
    const marked = await mkdtemp(join(tmpdir(), "fd-cwd-"));
    try {
      const { dir: loopDir } = await built(
        other,
        flow(
          [
            loop("l1"),
            script("s1", {
              parent: "l1",
              settings: { command: "sh", args: ["-c", "echo ran > marker.txt"] },
            }),
          ],
          [thenWire("l1", "s1")],
        ),
      );
      const { deps, recorded } = stubDeps(other);

      expect(
        await runCli(["run", loopDir, "--cwd", marked], {
          ...deps,
          scripts: new NodeProcessRunner(),
        }),
      ).toBe(2);
      expect(recorded.stderr.join("\n")).toContain("l1 (loop) has no prompt or agent in its body");
      await expect(access(join(marked, "marker.txt"))).rejects.toThrow();
      expect(recorded.startEvents).toEqual([]);
      expect(recorded.openSession).toEqual([]);
    } finally {
      await rm(marked, { recursive: true, force: true });
    }
  });

  describe("gates and asks", () => {
    const echoed = (text: string): ProcessResult => ({ code: 0, stdout: `${text}\n`, stderr: "" });
    const approve: WaitReply = { decision: "approve" };

    async function gateBuild(skippable = false) {
      const other = new FakeFileSystem();
      const { dir: gateDir } = await built(
        other,
        flow(
          [script("s1"), gate("g1", { settings: { skippable } }), script("s2")],
          [thenWire("s1", "g1"), thenWire("g1", "s2")],
        ),
      );
      return { other, gateDir };
    }

    it("runs past an approved Gate without starting Claude", async () => {
      const { other, gateDir } = await gateBuild();
      const { deps, recorded } = stubDeps(other, {
        results: [echoed("one"), echoed("two")],
        waiter: new FakeWaiter([approve]),
      });

      expect(await runCli(["run", gateDir, "--cwd", repo], deps)).toBe(0);
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
      const { other, gateDir } = await gateBuild();
      const { deps, recorded, scripts } = stubDeps(other, {
        results: [echoed("one"), echoed("two")],
        waiter: new FakeWaiter([{ decision: "reject", reason: "wrong scope" }]),
      });

      expect(await runCli(["run", gateDir, "--cwd", repo], deps)).toBe(1);
      expect(recorded.stdout.at(-1)).toBe("g1 failed: rejected: wrong scope");
      expect(scripts.calls).toHaveLength(1);
    });

    it("passes --auto to the run, so a skippable Gate is skipped without asking", async () => {
      const { other, gateDir } = await gateBuild(true);
      const waiter = new FakeWaiter([]);
      const { deps, recorded } = stubDeps(other, { results: [ok, ok], waiter });

      expect(await runCli(["run", gateDir, "--cwd", repo, "--auto"], deps)).toBe(0);
      expect(recorded.stdout).toContain("g1 skipped");
      expect(waiter.calls).toEqual([]);
    });

    it("asks at a skippable Gate without --auto", async () => {
      const { other, gateDir } = await gateBuild(true);
      const waiter = new FakeWaiter([approve]);
      const { deps } = stubDeps(other, { results: [ok, ok], waiter });

      expect(await runCli(["run", gateDir, "--cwd", repo], deps)).toBe(0);
      expect(waiter.calls).toHaveLength(1);
    });

    it("answers an Ask before a Script without starting Claude", async () => {
      const other = new FakeFileSystem();
      const { dir: askDir } = await built(
        other,
        flow([ask("q1"), script("s1")], [thenWire("q1", "s1")]),
      );
      const { deps, recorded } = stubDeps(other, {
        results: [ok],
        waiter: new FakeWaiter([{ decision: "answer", answer: "blue" }]),
      });

      expect(await runCli(["run", askDir, "--cwd", repo], deps)).toBe(0);
      expect(recorded.stdout).toEqual(["q1 answered: blue", "s1 started", "s1 done"]);
      expect(recorded.openSession).toEqual([]);
    });

    it("shows --auto in the run usage", async () => {
      const { deps, recorded } = stubDeps(fs);

      await runCli(["run"], deps);

      expect(recorded.stderr.join("\n")).toContain(
        "flowdeck run <buildDir> --cwd <repo> [--session <fd-name>] [--model <model>] [--auto]",
      );
    });
  });

  it("starts Claude and runs an agent-only build", async () => {
    const other = new FakeFileSystem();
    const { dir: agentDir, hash: agentHash } = await built(
      other,
      flow([trigger("t"), agent("a1"), output("o")], [thenWire("t", "a1"), thenWire("a1", "o")]),
    );
    const { deps, recorded } = stubDeps(other, { subagents: [`${agentHash}:a1`] });

    expect(await runCli(["run", agentDir, "--cwd", repo, "--session", "fd-a"], deps)).toBe(0);
    expect(recorded.openSession).toHaveLength(1);
    expect(recorded.stdout).toEqual(["a1 started", "a1 done"]);
  });

  it("runs the build, exits 0 and passes the build, model and socket to the session", async () => {
    const { deps, recorded, scripts } = stubDeps(fs, { results: [ok] });

    expect(await runCli(["run", dir, "--cwd", repo, "--session", "fd-a"], deps)).toBe(0);
    expect(recorded.openSession).toEqual([
      {
        sessionName: "fd-a",
        buildDir: dir,
        model: "sonnet",
        socketPath: "/fd-home/sockets/fd-a.sock",
        cwd: repo,
        claudeSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    expect(recorded.sends).toEqual([`/${hash}:p1`]);
    expect(scripts.calls).toEqual([{ command: "npm", args: ["test"], cwd: repo }]);
    expect(recorded.stdout).toEqual(["p1 started", "p1 done", "s1 started", "s1 done"]);
  });

  it("starts the session with the --model value when given", async () => {
    const { deps, recorded } = stubDeps(fs, { results: [ok] });

    await runCli(["run", dir, "--cwd", repo, "--model", "haiku"], deps);

    expect(recorded.openSession[0]?.model).toBe("haiku");
  });

  it("exits 1 when a node fails", async () => {
    const { deps, recorded } = stubDeps(fs, { results: [{ code: 1, stdout: "", stderr: "" }] });

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(1);
    expect(recorded.stdout.at(-1)).toBe("s1 failed: exit code 1");
  });

  describe("cleanup", () => {
    it.each([
      ["success", [ok], 0],
      ["a failed node", [{ code: 1, stdout: "", stderr: "" }], 1],
    ] as const)("stops the session and the events after %s", async (_, results, code) => {
      const { deps, recorded } = stubDeps(fs, { results: [...results] });

      expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(code);
      expect(recorded.sessionStops).toBe(1);
      expect(recorded.eventStops).toBe(1);
    });

    it("stops the session and the events when the runner throws", async () => {
      const { deps, recorded } = stubDeps(fs, { results: [ok] });
      const throwing: CliDeps = {
        ...deps,
        stdout: () => {
          throw new Error("stdout closed");
        },
      };

      expect(await runCli(["run", dir, "--cwd", repo], throwing)).toBe(1);
      expect(recorded.stderr.join("\n")).toContain("stdout closed");
      expect(recorded.sessionStops).toBe(1);
      expect(recorded.eventStops).toBe(1);
    });
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
    const fs = new FakeFileSystem();
    const { dir } = await built(fs, input);
    const log: string[] = [];
    const start = deferred<undefined>();
    const store = new FakeStore();
    let interrupt: (code: number) => void = () => undefined;
    const deps: CliDeps = {
      env: { FLOWDECK_HOME: home },
      openStore: () => store,
      transcriptTurns: async () => [],
      stdout: (line) => {
        log.push(`line ${line}`);
      },
      stderr: () => undefined,
      fs,
      waiter: new FakeWaiter([]),
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
    return { deps, dir, log, start, store };
  }

  it("never starts Claude for a prompt reached after the run was stopped", async () => {
    const blocked = deferred<ProcessResult>();
    const { deps, dir, log } = await interruptibleDeps(
      flow([shScript("s1"), prompt("p1")], [thenWire("s1", "p1")]),
      blocked.promise,
    );

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(130);
    blocked.resolve(ok);
    await settle();

    expect(log).not.toContain("start requested");
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual([]);
  });

  it("never runs a script reached after the run was stopped", async () => {
    const blocked = deferred<ProcessResult>();
    const { deps, dir, log } = await interruptibleDeps(
      flow([shScript("s1"), shScript("s2")], [thenWire("s1", "s2")]),
      blocked.promise,
    );

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(130);
    blocked.resolve(ok);
    await settle();

    expect(log.filter((entry) => entry === "script run")).toHaveLength(1);
  });

  it("stops a session whose start finishes after the run was stopped, and sends nothing", async () => {
    const { deps, dir, log, start } = await interruptibleDeps(
      flow([prompt("p1")], []),
      Promise.resolve(ok),
    );

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(130);
    start.resolve(undefined);
    await settle();

    expect(log.slice(log.indexOf("started"))).toContain("session stopped");
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual([]);
  });

  it("records the run as stopped when interrupted", async () => {
    const blocked = deferred<ProcessResult>();
    const { deps, dir, store } = await interruptibleDeps(
      flow([shScript("s1"), shScript("s2")], [thenWire("s1", "s2")]),
      blocked.promise,
    );

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(130);
    blocked.resolve(ok);
    await settle();

    expect(store.runs[0]?.status).toBe("stopped");
  });

  it("stops the attached session when a resume is interrupted", async () => {
    const { deps, dir, log, store, start } = await interruptibleDeps(
      flow([prompt("p1"), prompt("p2")], [thenWire("p1", "p2")]),
      Promise.resolve(ok),
    );
    const { id } = store.createRun({
      buildDir: dir,
      inputs: { cwd: repo },
      nodeIds: ["p1", "p2"],
      session: { tmuxName: "fd-a", cwd: repo, claudeSessionId: "c1" },
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
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "fd-home-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  const realDepsWith = (fs: NodeFileSystem) => stubDeps(fs, { env: { FLOWDECK_HOME: tempHome } });

  it("builds a valid flow and prints its hash and build folder", async () => {
    const flowPath = join(tempHome, "flow.json");
    await writeFile(flowPath, JSON.stringify(promptThenScript()));
    const nodeFs = new NodeFileSystem();
    const { deps, recorded } = realDepsWith(nodeFs);

    expect(await runCli(["build", flowPath], deps)).toBe(0);
    const [hashLine, dirLine] = recorded.stdout;
    const printedHash = hashLine?.replace(/^hash /, "") ?? "";
    expect(printedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dirLine).toBe(`dir ${join(tempHome, "builds", printedHash)}`);
    expect(await nodeFs.exists(join(tempHome, "builds", printedHash, "manifest.json"))).toBe(true);
  });

  it("prints each problem of an invalid flow and exits 2", async () => {
    const broken = fileURLToPath(new URL("../fixtures/broken/references.json", import.meta.url));
    const { deps, recorded } = realDepsWith(new NodeFileSystem());

    expect(await runCli(["build", broken], deps)).toBe(2);
    expect(recorded.stderr.length).toBeGreaterThan(0);
    expect(recorded.stderr.join("\n")).toContain("references");
    expect(recorded.stdout).toEqual([]);
  });
});

describe("runCli run state", () => {
  let fs: FakeFileSystem;
  let dir: string;

  beforeEach(async () => {
    fs = new FakeFileSystem();
    ({ dir } = await built(fs, promptThenScript()));
  });

  it("prints the run id first on stderr and stores the run, its session and its build", async () => {
    const { deps, recorded, store } = stubDeps(fs, { results: [ok] });

    expect(await runCli(["run", dir, "--cwd", repo, "--session", "fd-a"], deps)).toBe(0);

    const [run] = store.runs;
    expect(store.runs).toHaveLength(1);
    expect(recorded.stderr[0]).toBe(`run ${run?.id}`);
    expect(recorded.stdout).toEqual(["p1 started", "p1 done", "s1 started", "s1 done"]);
    expect(run).toMatchObject({
      buildDir: dir,
      status: "done",
      session: {
        tmuxName: "fd-a",
        cwd: repo,
        claudeSessionId: recorded.openSession[0]?.claudeSessionId,
      },
    });
    expect(store.nodes.map((node) => node.nodeId)).toEqual(["p1", "s1"]);
  });

  it("opens the store at FLOWDECK_HOME/flowdeck.db", async () => {
    const { deps, recorded } = stubDeps(fs, { results: [ok] });

    await runCli(["run", dir, "--cwd", repo], deps);

    expect(recorded.storePaths).toEqual(["/fd-home/flowdeck.db"]);
  });

  it("records a run that ends at a failed node as failed", async () => {
    const { deps, store } = stubDeps(fs, { results: [{ code: 1, stdout: "", stderr: "" }] });

    expect(await runCli(["run", dir, "--cwd", repo], deps)).toBe(1);
    expect(store.runs[0]?.status).toBe("failed");
  });
});

describe("runCli resume", () => {
  let fs: FakeFileSystem;
  let dir: string;
  let hash: string;
  const nodeIds = ["p1", "p2", "p3"];

  beforeEach(async () => {
    fs = new FakeFileSystem();
    ({ dir, hash } = await built(
      fs,
      flow(
        [prompt("p1"), prompt("p2"), prompt("p3")],
        [thenWire("p1", "p2"), thenWire("p2", "p3")],
      ),
    ));
  });

  const turn = (id: string, ended: boolean, lastAssistantText?: string): TranscriptTurn => ({
    userText: `<command-name>/${hash}:${id}</command-name>`,
    ended,
    ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
  });

  function seed(store: FakeStore, events: [string, RunEvent][], ids = nodeIds, buildDir = dir) {
    const { id } = store.createRun({
      buildDir,
      inputs: { cwd: repo, session: "fd-a" },
      nodeIds: ids,
      session: { tmuxName: "fd-a", cwd: repo, claudeSessionId: "c1" },
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
    const { deps, recorded, scripts } = stubDeps(fs);

    expect(await runCli(["resume", "nope"], deps)).toBe(1);
    expect(recorded.stderr).toEqual(["no run nope"]);
    nothingStarted(recorded, scripts);
  });

  it("sends nothing for a run that already finished", async () => {
    const { deps, recorded, store, scripts } = stubDeps(fs);
    const id = seed(store, []);
    store.finishRun(id, "done");

    expect(await runCli(["resume", id], deps)).toBe(0);
    expect(recorded.stderr).toEqual([`run ${id} already done`]);
    expect(recorded.sends).toEqual([]);
    expect(store.events(id)).toEqual([]);
    nothingStarted(recorded, scripts);
  });

  it("exits 1 naming the session when its tmux session is gone, starting and sending nothing", async () => {
    const { deps, recorded, store } = stubDeps(fs, { sessionGone: true });
    const id = seed(store, killedAtP2);

    expect(await runCli(["resume", id], deps)).toBe(1);
    expect(recorded.stderr.join("\n")).toContain('"fd-a" is gone');
    expect(recorded.startEvents).toEqual([]);
    expect(recorded.sends).toEqual([]);
    expect(store.events(id)).toHaveLength(killedAtP2.length);
  });

  it("listens before reading the transcript, completes node 2 without sending it and sends node 3 once", async () => {
    const { deps, recorded, store } = stubDeps(fs, {
      turns: [turn("p1", true, "A"), turn("p2", true, "X")],
    });
    const id = seed(store, killedAtP2);

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(recorded.order).toEqual(["listen", "transcript c1"]);
    expect(recorded.openSession).toEqual([
      {
        sessionName: "fd-a",
        buildDir: dir,
        model: "sonnet",
        socketPath: "/fd-home/sockets/fd-a.sock",
        cwd: repo,
        claudeSessionId: "c1",
        attach: true,
      },
    ]);
    expect(recorded.sends).toEqual([`/${hash}:p3`]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
    expect(store.findRun(id)?.status).toBe("done");
    expect(recorded.sessionStops).toBe(1);
    expect(recorded.eventStops).toBe(1);
  });

  it("reads the transcript again when node 2's Stop arrives during the read, completing it without a send", async () => {
    const { deps, recorded, store, source } = stubDeps(fs);
    const id = seed(store, killedAtP2);
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
    expect(recorded.sends).toEqual([`/${hash}:p3`]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
  });

  it("does not settle node 3 with node 2's Stop arriving after the read showed node 2 ended", async () => {
    const { deps, recorded, store, source } = stubDeps(fs);
    const id = seed(store, killedAtP2);
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

    expect(recorded.sends).toEqual([`/${hash}:p3`]);
    expect(store.events(id).filter((event) => event.nodeId === "p3")).not.toContainEqual(
      expect.objectContaining({ kind: "done", payload: { stopMessage: "X" } }),
    );
  });

  it("completes node 2 with the Stop seen during the first read when the re-read still shows it mid-turn", async () => {
    const { deps, recorded, store, source } = stubDeps(fs);
    const id = seed(store, killedAtP2);
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

    expect(recorded.sends).toEqual([`/${hash}:p3`]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
  });

  it("completes node 2 with its own Stop stamped before the wait was armed", async () => {
    const { deps, recorded, store, source } = stubDeps(fs);
    const id = seed(store, killedAtP2);
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

    expect(recorded.sends).toEqual([`/${hash}:p3`]);
    expect(store.events(id).filter((event) => event.nodeId === "p2")).toMatchObject([
      { kind: "sent" },
      { kind: "done", payload: { stopMessage: "X" } },
    ]);
  });

  it("opens a new session lazily when the run never sent a Claude turn", async () => {
    const { deps, recorded, store } = stubDeps(fs);
    const id = seed(store, []);

    expect(await runCli(["resume", id], deps)).toBe(0);

    expect(recorded.openSession[0]?.attach).toBeUndefined();
    expect(recorded.sends).toEqual([`/${hash}:p1`, `/${hash}:p2`, `/${hash}:p3`]);
    expect(store.findRun(id)?.status).toBe("done");
  });

  it("exits 1 with nothing sent when the transcript disagrees with the stored events", async () => {
    const { deps, recorded, store } = stubDeps(fs, {
      turns: [turn("p2", true, "X"), turn("p2", true, "Y")],
    });
    const id = seed(store, killedAtP2);

    expect(await runCli(["resume", id], deps)).toBe(1);
    expect(recorded.stderr.join("\n")).toContain("cannot resume p2");
    expect(recorded.sends).toEqual([]);
    expect(store.findRun(id)?.status).toBe("failed");
  });

  it("passes --auto to the resumed run, so a skippable Gate is skipped without asking", async () => {
    const other = new FakeFileSystem();
    const { dir: gateDir } = await built(
      other,
      flow(
        [script("s1"), gate("g1", { settings: { skippable: true } }), script("s2")],
        [thenWire("s1", "g1"), thenWire("g1", "s2")],
      ),
    );
    const waiter = new FakeWaiter([]);
    const { deps, recorded, store } = stubDeps(other, { results: [ok], waiter });
    const id = seed(
      store,
      [
        ["s1", { kind: "running" }],
        ["s1", { kind: "done" }],
      ],
      ["s1", "g1", "s2"],
      gateDir,
    );

    expect(await runCli(["resume", id, "--auto"], deps)).toBe(0);
    expect(recorded.stdout).toEqual(["g1 skipped", "s2 started", "s2 done"]);
    expect(waiter.calls).toEqual([]);
  });

  it("shows resume in the usage", async () => {
    const { deps, recorded } = stubDeps(fs);

    expect(await runCli(["resume"], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("flowdeck resume <id> [--auto]");
  });
});
