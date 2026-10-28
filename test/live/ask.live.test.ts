import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { realDeps, runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const runTimeoutMs = 300_000;
const colourWord = /\b(red|blue|green)\b/i;
const promptText =
  "Write a file colour.md whose only content is the colour the user answered, or NONE if no colour is named.";

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

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
        id: "q1",
        label: "Pick",
        type: "ask",
        position: at(1),
        settings: { question: "Pick a colour", options: ["red", "blue", "green"] },
      },
      {
        id: "p1",
        label: "Write",
        type: "prompt",
        position: at(2),
        settings: { instructions: promptText },
      },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(3),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [then("t", "q1"), then("q1", "p1"), then("p1", "o")],
    session: {
      name: "main",
      workingFolder: { kind: "worktree", branch: "main" },
      model: "haiku",
      allowedTools: [],
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

async function readOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

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

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("ask nodes with real claude", () => {
  const sessionName = `fd-live-ask-${process.pid}`;
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
    "attaches the Ask's answer to the next Prompt, which writes it to colour.md",
    { timeout: runTimeoutMs },
    async () => {
      const built = await build(liveFlow(), {
        fs: new NodeFileSystem(),
        home,
        hooks: { nodePath: process.execPath, hookScriptPath },
      });
      if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);
      const colourPath = join(repo.path, "colour.md");
      expect(await readOrMissing(colourPath)).toBeUndefined();
      expect(promptText).not.toMatch(colourWord);
      expect(await readFile(join(built.dir, "commands", "p1.md"), "utf8")).not.toMatch(colourWord);

      const real = realDeps();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const deps: CliDeps = {
        ...real,
        env: { ...process.env, FLOWDECK_HOME: home },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        waiter: new FakeWaiter([{ decision: "answer", answer: "blue" }]),
        openSession: async (options) => {
          const opened = await real.openSession(options);
          sessionIds.push(opened.sessionId);
          return opened;
        },
      };

      const code = await runCli(
        ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
        deps,
      );

      const colour = await readOrMissing(colourPath);
      console.log(
        [
          `hash: ${built.hash}`,
          `exit: ${code}`,
          `stdout:\n${stdout.join("\n")}`,
          `stderr:\n${stderr.join("\n")}`,
          `colour.md: ${JSON.stringify(colour)}`,
        ].join("\n"),
      );

      expect.soft(code).toBe(0);
      expect.soft(stdout).toEqual(["q1 answered: blue", "p1 started", "p1 done"]);
      expect.soft(colour, "colour.md exists").toBeDefined();
      const content = (colour ?? "").trim().toLowerCase();
      expect.soft(content, "colour.md names the answer").toContain("blue");
      expect.soft(content, "colour.md is not NONE").not.toBe("none");
    },
  );
});
