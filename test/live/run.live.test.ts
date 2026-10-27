import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { build } from "../../src/core/compiler/build.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const fixturePath = fileURLToPath(new URL("../fixtures/run-live-flow.json", import.meta.url));
const tsx = join(root, "node_modules", ".bin", "tsx");
const runDeadlineMs = 240_000;
const transcriptSettleMs = 10_000;
const promptIds = ["p1", "p2", "p3"];

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

type Entry = {
  type?: string;
  message?: { content?: unknown; stop_reason?: string | null };
};

type Exit = { code: number | null; stdout: string; stderr: string };

function runCliProcess(args: string[], env: NodeJS.ProcessEnv): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, ["src/cli/main.ts", ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const deadline = setTimeout(() => child.kill("SIGTERM"), runDeadlineMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, stdout, stderr });
    });
  });
}

function turnSequence(entries: Entry[], hash: string): string[] {
  const tokens: string[] = [];
  for (const entry of entries) {
    const content = JSON.stringify(entry.message?.content ?? "");
    const command = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
    if (entry.type === "user" && command) tokens.push(`command ${command[1]}`);
    if (entry.type === "assistant" && entry.message?.stop_reason === "end_turn") {
      if (tokens.at(-1) !== "end_turn") tokens.push("end_turn");
    }
  }
  return tokens.filter((token) => token === "end_turn" || token.startsWith(`command ${hash}:`));
}

function expectOneTurnPerPromptInOrder(entries: Entry[], hash: string): void {
  expect(turnSequence(entries, hash)).toEqual(
    promptIds.flatMap((id) => [`command ${hash}:${id}`, "end_turn"]),
  );
}

function expectOnlyOkWritten(porcelain: string): void {
  expect(porcelain.split("\n").filter((line) => line !== "")).toEqual(["?? ok.txt"]);
}

async function readTranscript(path: string): Promise<Entry[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as Entry);
}

async function settledTranscript(path: string, hash: string): Promise<Entry[]> {
  const deadline = Date.now() + transcriptSettleMs;
  let entries = await readTranscript(path);
  while (turnSequence(entries, hash).length < promptIds.length * 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    entries = await readTranscript(path);
  }
  return entries;
}

const snippet = (value: unknown) => JSON.stringify(value).slice(0, 160);

function describeEntry(entry: Entry): string {
  const content = entry.message?.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const tools = blocks.filter((block) => block.type === "tool_use").map((block) => block.name);
  const text =
    typeof content === "string"
      ? content
      : blocks.map((block) => block.text ?? block.content ?? "").join(" ");
  return `${entry.type} stop=${entry.message?.stop_reason ?? "-"} tools=[${tools.join(",")}] ${snippet(text)}`;
}

async function diagnostics(exit: Exit, porcelain: string, projectFolder: string): Promise<string> {
  const lines = [
    `flowdeck run exited ${exit.code}`,
    `stdout:\n${exit.stdout}`,
    `stderr:\n${exit.stderr}`,
    `git status --porcelain:\n${porcelain}`,
  ];
  for (const transcript of await transcriptsIn(projectFolder)) {
    const entries = await readTranscript(join(projectFolder, transcript));
    lines.push(`last entries of ${transcript}:`, ...entries.slice(-20).map(describeEntry));
  }
  return lines.join("\n");
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

async function transcriptsIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("flowdeck run with real claude", () => {
  const sessionName = `fd-live-run-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let slug: string;
  let projectFolder: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    slug = repo.path.replace(/[^a-zA-Z0-9]/g, "-");
    projectFolder = join(homedir(), ".claude", "projects", slug);
  });

  afterEach(async () => {
    try {
      const { stdout } = await run("tmux", [
        "-L",
        sessionName,
        "capture-pane",
        "-p",
        "-t",
        `=${sessionName}:`,
      ]);
      console.error(`pane of ${sessionName} before cleanup:\n${stdout}`);
      await run("tmux", ["-L", sessionName, "kill-server"]);
    } catch (error) {
      if (!hasCode(error, 1)) throw error;
    }
    const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    await rm(join(socketFolder, sessionName), { force: true });
    for (const transcript of await transcriptsIn(projectFolder)) {
      const sessionId = transcript.replace(/\.jsonl$/, "");
      await waitForClaudeToExit(sessionId);
      await rm(join(projectFolder, transcript));
      await rm(join(projectFolder, sessionId), { recursive: true, force: true });
      for (const folder of ["session-env", "file-history"]) {
        await rm(join(homedir(), ".claude", folder, sessionId), { recursive: true, force: true });
      }
    }
    await removeIfEmpty(join(projectFolder, "memory"));
    await removeIfEmpty(projectFolder);
    await rm(join("/private/tmp", `claude-${userInfo().uid}`, slug), {
      recursive: true,
      force: true,
    });
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "runs three prompts one turn each, in order, writing only ok.txt",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const fixture = parseFlow(JSON.parse(await readFile(fixturePath, "utf8")));
      const flow = {
        ...fixture,
        nodes: fixture.nodes.map((node) =>
          node.type === "prompt"
            ? {
                ...node,
                settings: {
                  instructions: node.settings.instructions.replaceAll("{{repo}}", repo.path),
                },
              }
            : node,
        ),
      };
      const built = await build(flow, {
        fs: new NodeFileSystem(),
        home,
        hooks: { nodePath: process.execPath, hookScriptPath },
      });
      if (!built.ok) throw new Error(`fixture does not build: ${JSON.stringify(built.errors)}`);
      const env: NodeJS.ProcessEnv = { ...process.env, FLOWDECK_HOME: home };
      delete env.TMUX;
      delete env.TMUX_PANE;

      const exit = await runCliProcess(
        ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
        env,
      );

      const porcelain = (await run("git", ["status", "--porcelain"], { cwd: repo.path })).stdout;
      const transcripts = await transcriptsIn(projectFolder);
      for (const transcript of transcripts) {
        await waitForClaudeToExit(transcript.replace(/\.jsonl$/, ""));
      }
      const entries =
        transcripts.length === 1
          ? await settledTranscript(join(projectFolder, transcripts[0] ?? ""), built.hash)
          : [];
      try {
        expect(exit.code).toBe(0);
        expect(exit.stdout.split("\n").filter((line) => line !== "")).toEqual(
          promptIds.flatMap((id) => [`${id} started`, `${id} done`]),
        );
        expectOnlyOkWritten(porcelain);
        expect(transcripts).toHaveLength(1);
        expectOneTurnPerPromptInOrder(entries, built.hash);
      } catch (error) {
        console.error(await diagnostics(exit, porcelain, projectFolder));
        throw error;
      }
    },
  );
});
