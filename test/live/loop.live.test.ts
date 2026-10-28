import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { realDeps, runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import type { TurnEvents } from "../../src/core/run/turns.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import { paneText, transcriptTail, withWatchdog } from "../fixtures/live-evidence.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const watchdogMs = 240_000;
const runTimeoutMs = 300_000;
const condition = "every error the review reported is fixed";
const reviewText =
  "Run `node --check src/greet.js`, `node --check src/total.js` and `node --check src/math.js` as three separate Bash commands. Report each error with its file name and line. Do not change any file.";
const fixText =
  "Fix only the errors that the review earlier in this conversation reported, in the files it named. Do not run any command or open any other file. If there is no review earlier in this conversation, change nothing.";
const namesTheError = /\b(math|check|src)\b/i;

const files = {
  "src/greet.js":
    'function greet(name) {\n  return "hi " + name;\n}\nmodule.exports = { greet };\n',
  "src/total.js":
    "function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n",
  "src/math.js": "function add(a, b) {\n  return a + b;\n\nmodule.exports = { add };\n",
};

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

async function claudeRunning(sessionId: string): Promise<boolean> {
  try {
    await run("pgrep", ["-f", `session-id ${sessionId}`]);
    return true;
  } catch (error) {
    if (hasCode(error, 1)) return false;
    throw error;
  }
}

async function waitForClaudeToExit(sessionId: string): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    if (!(await claudeRunning(sessionId))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`claude for session ${sessionId} did not exit`);
}

async function removeIfEmpty(folder: string): Promise<void> {
  try {
    await rmdir(folder);
  } catch (error) {
    if (!hasCode(error, "ENOTEMPTY", "ENOENT")) throw error;
  }
}

function liveFlow() {
  return parseFlow({
    nodes: [
      {
        id: "t",
        label: "Start",
        type: "trigger",
        position: at(0),
        settings: { inputs: [], flags: {} },
      },
      {
        id: "l1",
        label: "Until fixed",
        type: "loop",
        position: at(1),
        settings: { condition, cap: 3, onCap: "fail" },
      },
      {
        id: "review",
        label: "Review",
        type: "prompt",
        position: at(2),
        parent: "l1",
        settings: { instructions: reviewText },
      },
      {
        id: "fix",
        label: "Fix",
        type: "prompt",
        position: at(3),
        parent: "l1",
        settings: { instructions: fixText },
      },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(4),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [then("t", "review"), then("review", "fix"), then("fix", "review"), then("fix", "o")],
    session: {
      name: "main",
      workingFolder: { kind: "worktree", branch: "main" },
      model: "haiku",
      allowedTools: ["Bash(node --check:*)"],
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

async function nodeIn(cwd: string, ...args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(process.execPath, args, { cwd });
    return { code: 0, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stderr?: unknown };
    return {
      code: typeof failed.code === "number" ? failed.code : -1,
      stderr: String(failed.stderr ?? ""),
    };
  }
}

const roundsOf = (lines: string[]) => {
  const rounds: string[][] = [];
  for (const line of lines) {
    if (/^l1 round \d+$/.test(line)) rounds.push([]);
    else rounds.at(-1)?.push(line);
  }
  return rounds;
};

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("loop nodes with real claude", () => {
  const sessionName = `fd-live-loop-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let slug: string;
  let claudeTmp: string;
  let projectFolder: string;
  let sessionIds: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    slug = repo.path.replace(/[^a-zA-Z0-9]/g, "-");
    claudeTmp = join("/private/tmp", `claude-${userInfo().uid}`, slug);
    projectFolder = join(homedir(), ".claude", "projects", slug);
    sessionIds = [];
  });

  afterEach(async () => {
    try {
      await run("tmux", ["-L", sessionName, "kill-server"]);
      console.error(`killed a tmux server left on ${sessionName}`);
    } catch (error) {
      if (!hasCode(error, 1)) throw error;
    }
    const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    await rm(join(socketFolder, sessionName), { force: true });
    for (const sessionId of sessionIds) {
      await waitForClaudeToExit(sessionId);
      await rm(join(projectFolder, `${sessionId}.jsonl`), { force: true });
      await rm(join(projectFolder, sessionId), { recursive: true, force: true });
      for (const folder of ["session-env", "file-history"]) {
        await rm(join(homedir(), ".claude", folder, sessionId), { recursive: true, force: true });
      }
    }
    await removeIfEmpty(join(projectFolder, "memory"));
    await removeIfEmpty(projectFolder);
    await rm(claudeTmp, { recursive: true, force: true });
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "loops a reviewer and a fixer until the planted syntax error is fixed",
    { timeout: runTimeoutMs },
    async () => {
      await mkdir(join(repo.path, "src"));
      for (const [path, content] of Object.entries(files)) {
        await writeFile(join(repo.path, path), content);
      }
      const built = await build(liveFlow(), {
        fs: new NodeFileSystem(),
        home,
        hooks: { nodePath: process.execPath, hookScriptPath },
      });
      if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);
      const before = await nodeIn(repo.path, "--check", "src/math.js");
      console.log(`node --check src/math.js before: exit ${before.code}\n${before.stderr}`);
      expect(before.code).not.toBe(0);
      expect((await nodeIn(repo.path, "--check", "src/greet.js")).code).toBe(0);
      expect((await nodeIn(repo.path, "--check", "src/total.js")).code).toBe(0);
      expect(fixText).not.toMatch(namesTheError);
      expect(condition).not.toMatch(namesTheError);
      expect(await readFile(join(built.dir, "commands", "fix.md"), "utf8")).not.toMatch(
        namesTheError,
      );

      const real = realDeps();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const replies: string[] = [];
      let events: TurnEvents | undefined;
      let stopRun: ((exitCode: number) => void) | undefined;
      const deps: CliDeps = {
        ...real,
        env: { ...process.env, FLOWDECK_HOME: home },
        stdout: (line) => {
          stdout.push(line);
          console.log(`cli: ${line}`);
        },
        stderr: (line) => {
          stderr.push(line);
          console.error(`cli: ${line}`);
        },
        onInterrupt: (handler) => {
          stopRun = handler;
          return () => {
            stopRun = undefined;
          };
        },
        waiter: new FakeWaiter([]),
        startEvents: async (socketPath) => {
          const started = await real.startEvents(socketPath);
          events = started.events;
          return started;
        },
        openSession: async (options) => {
          const opened = await real.openSession(options);
          sessionIds.push(opened.sessionId);
          events?.subscribe("Stop", opened.sessionId, (event) => {
            replies.push(String(event.payload["last_assistant_message"]));
          });
          return opened;
        },
      };

      const code = await withWatchdog(
        runCli(
          ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
          deps,
        ),
        watchdogMs,
        async () => {
          const transcripts = await Promise.all(
            sessionIds.map((id) => transcriptTail(join(projectFolder, `${id}.jsonl`))),
          );
          console.error(
            [
              `watchdog fired after ${watchdogMs} ms`,
              `pane:\n${await paneText(sessionName, sessionName)}`,
              ...transcripts.map((lines) => `transcript tail:\n${lines.join("\n")}`),
            ].join("\n"),
          );
          stopRun?.(1);
        },
      );

      const rounds = roundsOf(stdout);
      const after = await nodeIn(repo.path, "--check", "src/math.js");
      const adds = await nodeIn(
        repo.path,
        "-e",
        "process.exit(require('./src/math.js').add(2, 3) === 5 ? 0 : 1)",
      );
      const math = await readFile(join(repo.path, "src/math.js"), "utf8");
      console.log(
        [
          `hash: ${built.hash}`,
          `exit: ${code}`,
          `stdout:\n${stdout.join("\n")}`,
          `stderr:\n${stderr.join("\n")}`,
          `rounds: ${rounds.length}`,
          ...replies.map((reply, i) => `reply ${i + 1}:\n${reply}`),
          `node --check src/math.js after: exit ${after.code}\n${after.stderr}`,
          `add(2, 3) === 5: exit ${adds.code}`,
          `src/math.js after:\n${math}`,
        ].join("\n"),
      );

      expect.soft(code).toBe(0);
      expect.soft(stdout).toContain("l1 round 1");
      expect.soft(rounds.length).toBeGreaterThanOrEqual(1);
      expect.soft(rounds.length).toBeLessThanOrEqual(3);
      for (const round of rounds) {
        expect.soft(round).toContain("review done");
        expect.soft(round).toContain("fix done");
      }
      expect.soft(stdout.filter((line) => line.startsWith("l1 ")).at(-1)).toBe("l1 done");
      expect.soft(after.code, "node --check src/math.js passes").toBe(0);
      expect.soft(adds.code, "add(2, 3) is 5").toBe(0);
    },
  );
});
