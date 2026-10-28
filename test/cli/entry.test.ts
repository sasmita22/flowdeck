import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { build } from "../../src/core/compiler/build.js";
import { ask, flow, gate, script, thenWire } from "../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const mainPath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const exitWithinMs = 15_000;

type Exit = { code: number | null; exitedByItself: boolean; stdout: string };

function runEntry(
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    imports?: string[];
    signal?: { after: string; send: NodeJS.Signals };
    stdin?: string;
  },
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const imports = (options.imports ?? []).flatMap((path) => [
      "--import",
      pathToFileURL(path).href,
    ]);
    const child = spawn(process.execPath, ["--import", "tsx", ...imports, mainPath, ...args], {
      cwd: root,
      env: options.env,
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    let stdout = "";
    let exitedByItself = true;
    let signalled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.signal && !signalled && stdout.includes(options.signal.after)) {
        signalled = true;
        child.kill(options.signal.send);
      }
    });
    const deadline = setTimeout(() => {
      exitedByItself = false;
      child.kill("SIGKILL");
    }, exitWithinMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, exitedByItself, stdout });
    });
  });
}

describe("the flowdeck entry", () => {
  const sleepArg = `30.${process.pid}`;
  let home: string;
  let repo: TmpRepo;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
  });

  afterEach(async () => {
    await run("pkill", ["-f", `^sleep ${sleepArg}$`]).catch(() => undefined);
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  async function buildFlow(nodes: unknown[], wires: unknown[]) {
    const built = await build(flow(nodes, wires), {
      fs: new NodeFileSystem(),
      home,
      hooks: { nodePath: process.execPath, hookScriptPath: "/h" },
    });
    if (!built.ok) throw new Error("build failed");
    return built.dir;
  }

  const buildScript = (args: string[]) =>
    buildFlow([script("s", { settings: { command: args[0], args: args.slice(1) } })], []);

  const gateThenScript = () =>
    buildFlow(
      [gate("g1"), script("s1", { settings: { command: "echo", args: ["after"] } })],
      [thenWire("g1", "s1")],
    );

  it(
    "reads a Gate's and an Ask's answers from one piped write",
    { timeout: exitWithinMs + 10_000 },
    async () => {
      const dir = await buildFlow(
        [gate("g1"), ask("q1"), script("s1", { settings: { command: "echo", args: ["after"] } })],
        [thenWire("g1", "q1"), thenWire("q1", "s1")],
      );

      const exit = await runEntry(["run", dir, "--cwd", repo.path], {
        env: { ...process.env, FLOWDECK_HOME: home },
        stdin: "approve\n2\n",
      });

      expect(exit.exitedByItself).toBe(true);
      expect(exit.code).toBe(0);
      expect(exit.stdout).toContain("g1 approved\n");
      expect(exit.stdout).toContain("q1 answered: blue\n");
    },
  );

  it(
    "fails a Gate whose stdin closed before it asked, exiting 1",
    { timeout: exitWithinMs + 10_000 },
    async () => {
      const dir = await gateThenScript();

      const exit = await runEntry(["run", dir, "--cwd", repo.path], {
        env: { ...process.env, FLOWDECK_HOME: home },
        stdin: "",
      });

      expect(exit.exitedByItself).toBe(true);
      expect(exit.code).toBe(1);
      expect(exit.stdout).toContain("g1 failed: no answer: input closed\n");
    },
  );

  it(
    "on SIGINT while a Gate waits for an answer exits 130",
    { timeout: exitWithinMs + 10_000 },
    async () => {
      const dir = await gateThenScript();

      const exit = await runEntry(["run", dir, "--cwd", repo.path, "--session", "fd-wait"], {
        env: { ...process.env, FLOWDECK_HOME: home },
        signal: { after: "approve, or reject <reason>: ", send: "SIGINT" },
      });

      expect(exit.exitedByItself).toBe(true);
      expect(exit.code).toBe(130);
      expect(await readdir(join(home, "sockets"))).toEqual([]);
    },
  );

  it(
    "exits with the run's code even while a timer is still armed",
    { timeout: exitWithinMs + 10_000 },
    async () => {
      const lingerPath = join(home, "linger.mjs");
      await writeFile(lingerPath, "setTimeout(() => undefined, 600_000);\n");
      const dir = await buildScript(["true"]);

      const exit = await runEntry(["run", dir, "--cwd", repo.path], {
        env: { ...process.env, FLOWDECK_HOME: home },
        imports: [lingerPath],
      });

      expect(exit.exitedByItself).toBe(true);
      expect(exit.code).toBe(0);
      expect(exit.stdout).toBe("s started\ns done\n");
    },
  );

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "on %s stops a blocked run, removes its hook socket and exits %i",
    { timeout: exitWithinMs + 10_000 },
    async (signal, code) => {
      const dir = await buildScript(["sh", "-c", `exec sleep ${sleepArg}`]);

      const exit = await runEntry(["run", dir, "--cwd", repo.path, "--session", "fd-signal"], {
        env: { ...process.env, FLOWDECK_HOME: home },
        signal: { after: "s started", send: signal },
      });

      expect(exit.exitedByItself).toBe(true);
      expect(exit.code).toBe(code);
      expect(await readdir(join(home, "sockets"))).toEqual([]);
    },
  );
});
