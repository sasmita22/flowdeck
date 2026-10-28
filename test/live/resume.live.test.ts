import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { build } from "../../src/core/compiler/build.js";
import { flow, prompt, thenWire } from "../fixtures/flow-builders.js";
import { paneText, transcriptTail, withWatchdog } from "../fixtures/live-evidence.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const mainPath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const watchdogMs = 180_000;
const words = { p1: "ALPHA", p2: "BRAVO", p3: "CHARLIE" };

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Cli = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
};

function startCli(args: string[], env: NodeJS.ProcessEnv): Cli {
  const child = spawn(process.execPath, ["--import", "tsx", mainPath, ...args], { cwd: root, env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exit };
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(100);
  }
}

type Entry = {
  type?: string;
  isMeta?: boolean;
  message?: { content?: unknown; stop_reason?: string };
};

async function entriesOf(path: string): Promise<Entry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  return raw.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as Entry];
    } catch {
      return [];
    }
  });
}

const commandOf = (hash: string, id: string) => `<command-name>/${hash}:${id}</command-name>`;

const userIndexes = (entries: Entry[], marker: string) =>
  entries.flatMap((entry, i) =>
    entry.type === "user" &&
    entry.isMeta !== true &&
    JSON.stringify(entry.message?.content ?? "").includes(marker)
      ? [i]
      : [],
  );

async function claudeRunning(sessionId: string): Promise<boolean> {
  try {
    await run("pgrep", ["-f", `session-id ${sessionId}`]);
    return true;
  } catch (error) {
    if (hasCode(error, 1)) return false;
    throw error;
  }
}

async function removeIfEmpty(folder: string): Promise<void> {
  try {
    await rmdir(folder);
  } catch (error) {
    if (!hasCode(error, "ENOTEMPTY", "ENOENT")) throw error;
  }
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("flowdeck resume with real claude", () => {
  const sessionName = `fd-live-resume-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let projectFolder: string;
  let slug: string;
  const children: ChildProcess[] = [];
  const stores: SqliteStore[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    slug = repo.path.replace(/[^a-zA-Z0-9]/g, "-");
    projectFolder = join(homedir(), ".claude", "projects", slug);
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const store of stores.splice(0)) store.close();
    await run("tmux", ["-L", sessionName, "kill-server"]).catch(() => undefined);
    const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    await rm(join(socketFolder, sessionName), { force: true });
    let transcripts: string[] = [];
    try {
      transcripts = (await readdir(projectFolder)).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    for (const transcript of transcripts) {
      const sessionId = transcript.replace(/\.jsonl$/, "");
      for (let waited = 0; waited < 10_000 && (await claudeRunning(sessionId)); waited += 100) {
        await sleep(100);
      }
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
    "resumes a run killed during node 2 without resending it, and runs node 3",
    { timeout: watchdogMs + 30_000 },
    async () => {
      const built = await build(
        flow(
          (["p1", "p2", "p3"] as const).map((id) =>
            prompt(id, { settings: { instructions: `Reply with the single word ${words[id]}.` } }),
          ),
          [thenWire("p1", "p2"), thenWire("p2", "p3")],
        ),
        { fs: new NodeFileSystem(), home, hooks: { nodePath: process.execPath, hookScriptPath } },
      );
      if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);
      const env: NodeJS.ProcessEnv = { ...process.env, FLOWDECK_HOME: home };
      delete env.TMUX;
      delete env.TMUX_PANE;
      let transcriptPath = "";
      let lastPane = "";
      const evidence = async () => {
        console.error(`pane:\n${await paneText(sessionName, sessionName)}`);
        console.error(`transcript tail:\n${(await transcriptTail(transcriptPath)).join("\n")}`);
      };

      const first = startCli(
        ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
        env,
      );
      children.push(first.child);
      const runId = await withWatchdog(
        until(() => /^run (\S+)$/m.exec(first.stderr())?.[1]),
        30_000,
        evidence,
      );
      const store = new SqliteStore({ path: join(home, "flowdeck.db") });
      stores.push(store);
      const claudeSessionId = store.findRun(runId)?.session.claudeSessionId ?? "";
      transcriptPath = join(projectFolder, `${claudeSessionId}.jsonl`);
      await withWatchdog(
        until(async () => {
          const sent = store.events(runId).some((e) => e.nodeId === "p2" && e.kind === "sent");
          const delivered =
            userIndexes(await entriesOf(transcriptPath), commandOf(built.hash, "p2")).length > 0;
          return sent && delivered ? true : undefined;
        }),
        120_000,
        evidence,
      );
      first.child.kill("SIGKILL");
      await first.exit;

      const second = startCli(["resume", runId], env);
      children.push(second.child);
      const polling = (async () => {
        while (second.child.exitCode === null) {
          const pane = await paneText(sessionName, sessionName);
          if (!pane.startsWith("no pane")) lastPane = pane;
          await sleep(100);
        }
      })();
      const code = await withWatchdog(second.exit, 150_000, evidence);
      await polling;

      for (
        let waited = 0;
        waited < 10_000 && (await claudeRunning(claudeSessionId));
        waited += 100
      ) {
        await sleep(100);
      }
      const entries = await entriesOf(transcriptPath);
      const p2Turns = userIndexes(entries, commandOf(built.hash, "p2"));
      const p3Turns = userIndexes(entries, commandOf(built.hash, "p3"));
      const p3Ended = entries
        .slice((p3Turns[0] ?? entries.length) + 1)
        .some((entry) => entry.type === "assistant" && entry.message?.stop_reason === "end_turn");
      const p3Done = store.events(runId).find((e) => e.nodeId === "p3" && e.kind === "done");
      const report = [
        `resume exited ${code}`,
        `stdout:\n${second.stdout()}`,
        `stderr:\n${second.stderr()}`,
        `last pane:\n${lastPane}`,
        `transcript tail:\n${(await transcriptTail(transcriptPath)).join("\n")}`,
      ].join("\n");

      const paneLines = lastPane.split("\n").map((line) => line.trim());
      expect(code, report).toBe(0);
      expect(
        paneLines.filter((line) => line === `❯ /${built.hash}:p2`),
        report,
      ).toHaveLength(1);
      expect(paneLines, report).toContain(`❯ /${built.hash}:p3`);
      expect(p2Turns, report).toHaveLength(1);
      expect(p3Turns, report).toHaveLength(1);
      expect(p3Ended, report).toBe(true);
      expect(store.findRun(runId)?.status, report).toBe("done");
      expect(p3Done, report).toMatchObject({
        payload: { stopMessage: expect.stringContaining(words.p3) },
      });
    },
  );
});
