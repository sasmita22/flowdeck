import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { EventLog } from "../../src/adapters/jsonl/event-log.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { realDeps, runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import { agentTurnText } from "../../src/core/nodes/agent/execute.js";
import type { HookEvent } from "../../src/ports/event-source.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const runTimeoutMs = 300_000;
const hookKinds = ["Stop", "PreToolUse", "PostToolUse", "SubagentStop"] as const;

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

type LogLine = { kind?: string; tool_name?: string | null; agent_type?: string | null };

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function liveFlow(secret: string) {
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
        id: "p1",
        label: "Tell",
        type: "prompt",
        position: at(1),
        settings: { instructions: `The secret word is ${secret}. Reply only OK.` },
      },
      {
        id: "a1",
        label: "Notes",
        type: "agent",
        position: at(2),
        settings: {
          role: "",
          instructions:
            "Write a file notes.md whose only content is the secret word you were told. If you were not told one, write UNKNOWN.",
          model: "haiku",
          tools: ["Write"],
        },
      },
      {
        id: "p2",
        label: "Control",
        type: "prompt",
        position: at(3),
        settings: {
          instructions: "Write a file control.md whose only content is the secret word I told you.",
        },
      },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(4),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [then("t", "p1"), then("p1", "a1"), then("a1", "p2"), then("p2", "o")],
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

async function readEventLog(path: string): Promise<LogLine[]> {
  const text = (await readOrMissing(path)) ?? "";
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as LogLine);
}

async function listRecursive(folder: string): Promise<string[]> {
  try {
    return await readdir(folder, { recursive: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

const describeEvent = ({ kind, payload }: HookEvent) =>
  [
    kind,
    payload["tool_name"],
    payload["agent_type"],
    kind === "PreToolUse" ? JSON.stringify(payload["tool_input"]) : undefined,
    kind === "PostToolUse" && payload["tool_name"] === "Agent"
      ? JSON.stringify(payload["tool_response"]).slice(0, 200)
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

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

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("agent nodes with real claude", () => {
  const sessionName = `fd-live-agent-${process.pid}`;
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
    "runs the agent as a subagent that writes notes.md without the conversation's secret",
    { timeout: runTimeoutMs },
    async () => {
      const secret = `s${randomBytes(5).toString("hex")}`;
      const built = await build(liveFlow(secret), {
        fs: new NodeFileSystem(),
        home,
        hooks: { nodePath: process.execPath, hookScriptPath },
      });
      if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);
      const notesPath = join(repo.path, "notes.md");
      const controlPath = join(repo.path, "control.md");
      await rm(notesPath, { force: true });
      expect(await readOrMissing(notesPath)).toBeUndefined();
      expect(await readFile(join(built.dir, "agents", "a1.md"), "utf8")).not.toContain(secret);
      expect(agentTurnText(built.hash, "a1")).not.toContain(secret);

      const logPath = join(home, "runs", "agent", "events.jsonl");
      const recorded: HookEvent[] = [];
      let server: HookSocketServer | undefined;
      const real = realDeps();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const deps: CliDeps = {
        ...real,
        env: { ...process.env, FLOWDECK_HOME: home },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        startEvents: async (socketPath) => {
          await mkdir(dirname(socketPath), { recursive: true });
          server = new HookSocketServer({ socketPath });
          await server.start();
          const started = server;
          return { events: started, stop: () => started.stop() };
        },
        openSession: async (options) => {
          const opened = await real.openSession(options);
          sessionIds.push(opened.sessionId);
          if (server === undefined) throw new Error("hook socket not started");
          new EventLog({ events: server, path: logPath, runId: "agent" }).watch(opened.sessionId);
          for (const kind of hookKinds) {
            server.subscribe(kind, opened.sessionId, (event) => recorded.push(event));
          }
          return opened;
        },
      };

      const code = await runCli(
        ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
        deps,
      );

      const notes = await readOrMissing(notesPath);
      const control = await readOrMissing(controlPath);
      const log = await readEventLog(logPath);
      console.log(
        [
          `secret: ${secret}`,
          `hash: ${built.hash}`,
          `exit: ${code}`,
          `stdout:\n${stdout.join("\n")}`,
          `stderr:\n${stderr.join("\n")}`,
          `notes.md: ${JSON.stringify(notes)}`,
          `control.md: ${JSON.stringify(control)}`,
          `git status --porcelain:\n${(await run("git", ["status", "--porcelain"], { cwd: repo.path })).stdout}`,
          `files under ${claudeTmp}: ${JSON.stringify(await listRecursive(claudeTmp))}`,
          `hook events in order:\n${recorded.map(describeEvent).join("\n")}`,
        ].join("\n"),
      );

      expect.soft(code).toBe(0);
      expect
        .soft(stdout)
        .toEqual(["p1 started", "p1 done", "a1 started", "a1 done", "p2 started", "p2 done"]);
      expect.soft(notes, "notes.md exists").toBeDefined();
      expect
        .soft(
          log.filter((line) => line.kind === "SubagentStop").map((line) => line.agent_type),
          "a SubagentStop for the build's agent",
        )
        .toContain(`${built.hash}:a1`);
      expect.soft(notes ?? "", "the subagent does not know the secret").not.toContain(secret);
      expect.soft(control ?? "", "positive control: the main session knows it").toContain(secret);
    },
  );
});
