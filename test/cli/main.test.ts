import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import type { Flow } from "../../src/core/flow/schema.js";
import type { ProcessResult } from "../../src/ports/process-runner.js";
import { FakeEventSource } from "../fakes/fake-event-source.js";
import { FakeFileSystem } from "../fakes/fake-file-system.js";
import { FakeProcessRunner } from "../fakes/fake-process-runner.js";
import { agent, flow, prompt, script, thenWire } from "../fixtures/flow-builders.js";

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
};

function stubDeps(
  fs: CliDeps["fs"],
  options: { env?: Record<string, string>; results?: ProcessResult[] } = {},
) {
  const source = new FakeEventSource();
  const scripts = new FakeProcessRunner(options.results ?? []);
  const recorded: Recorded = {
    startEvents: [],
    openSession: [],
    sends: [],
    sessionStops: 0,
    eventStops: 0,
    stdout: [],
    stderr: [],
  };
  const deps: CliDeps = {
    env: options.env ?? { FLOWDECK_HOME: home },
    stdout: (line) => recorded.stdout.push(line),
    stderr: (line) => recorded.stderr.push(line),
    fs,
    scripts,
    startEvents: async (socketPath) => {
      recorded.startEvents.push(socketPath);
      return {
        events: source,
        stop: async () => {
          recorded.eventStops++;
        },
      };
    },
    openSession: async (session) => {
      recorded.openSession.push(session);
      return {
        sessionId,
        session: { ensureStarted: async () => undefined },
        prompts: {
          sendPrompt: async (text) => {
            recorded.sends.push(text);
            setTimeout(() => source.publish({ kind: "Stop", sessionId, payload: {} }), 0);
          },
        },
        stop: async () => {
          recorded.sessionStops++;
        },
      };
    },
  };
  return { deps, recorded, scripts };
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

  it("refuses unsupported node types in one error before starting anything", async () => {
    const other = new FakeFileSystem();
    const { dir: agentDir } = await built(
      other,
      flow([prompt("p1"), agent("a1")], [thenWire("p1", "a1")]),
    );
    const { deps, recorded, scripts } = stubDeps(other);

    expect(await runCli(["run", agentDir, "--cwd", repo], deps)).toBe(2);
    expect(recorded.stderr.join("\n")).toContain("a1 (agent)");
    nothingStarted(recorded, scripts);
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
    let interrupt: (code: number) => void = () => undefined;
    const deps: CliDeps = {
      env: { FLOWDECK_HOME: home },
      stdout: (line) => {
        log.push(`line ${line}`);
      },
      stderr: () => undefined,
      fs,
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
    return { deps, dir, log, start };
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
