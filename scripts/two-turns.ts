import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeCli,
  type ClaudeSession,
  type ClaudeStartOptions,
} from "../src/adapters/claude/claude-cli.js";
import { writeHookSettings } from "../src/adapters/claude/write-hook-settings.js";
import { HookSocketServer } from "../src/adapters/hook-socket/hook-socket-server.js";
import { TmuxSessionHost } from "../src/adapters/tmux/tmux-session-host.js";
import type { SessionHost } from "../src/ports/session-host.js";
import { hookSettings } from "../src/core/compiler/hook-settings.js";
import { waitForTurnEnd, type TurnEndEvent, type TurnEvents } from "../src/core/run/turns.js";

const hookScriptPath = fileURLToPath(new URL("../bin/flowdeck-hook.ts", import.meta.url));
const maxSocketPath = 104;

export function twoTurnsSettings(options: { nodePath: string; hookScriptPath: string }) {
  const settings = { ...hookSettings(options), permissions: { defaultMode: "acceptEdits" } };
  return settings;
}

export function twoTurnsPrompts(token: string): { a: string; b: string } {
  return {
    a: `Use the Write tool to create a.txt containing exactly: ${token}`,
    b: "Read a.txt, then use the Write tool to create b.txt containing exactly the same text.",
  };
}

export async function sendTwoTurns(options: {
  claude: ClaudeCli;
  events: TurnEvents;
  name: string;
  sessionId: string;
  prompts: { a: string; b: string };
  turnTimeoutMs: number;
}): Promise<[TurnEndEvent, TurnEndEvent]> {
  const turn = async (prompt: string) => {
    const turnEnd = waitForTurnEnd(options.events, options.sessionId, options.turnTimeoutMs);
    await options.claude.sendPrompt(options.name, prompt);
    return turnEnd;
  };
  const stopA = await turn(options.prompts.a);
  const stopB = await turn(options.prompts.b);
  return [stopA, stopB];
}

export async function driveTwoTurns(options: {
  claude: ClaudeCli;
  sessions: SessionHost;
  events: TurnEvents;
  closeEvents: () => Promise<void>;
  name: string;
  cwd: string;
  session: ClaudeSession;
  startOptions: ClaudeStartOptions;
  turnTimeoutMs: number;
}): Promise<{ token: string; stops: [TurnEndEvent, TurnEndEvent] }> {
  const { claude, sessions, name } = options;
  const token = randomUUID();
  try {
    await claude.start(name, options.cwd, options.session, options.startOptions);
    await claude.waitUntilReady(name);
    const stops = await sendTwoTurns({
      claude,
      events: options.events,
      name,
      sessionId: options.session.sessionId,
      prompts: twoTurnsPrompts(token),
      turnTimeoutMs: options.turnTimeoutMs,
    });
    return { token, stops };
  } finally {
    if (await sessions.has(name)) await sessions.stop(name);
    await options.closeEvents();
  }
}

export async function runTwoTurns(options: {
  home: string;
  cwd: string;
  model: string;
  nodePath?: string;
  timeoutMs?: number;
}): Promise<{
  sessionId: string;
  token: string;
  transcriptPath: string;
  stops: [TurnEndEvent, TurnEndEvent];
  socketName: string;
}> {
  await mkdir(options.home, { recursive: true });
  const socketPath = join(options.home, "hook.sock");
  if (socketPath.length > maxSocketPath) {
    throw new Error(`Socket path "${socketPath}" is longer than ${maxSocketPath} characters`);
  }
  const server = new HookSocketServer({ socketPath });
  await server.start();
  const sessionId = randomUUID();
  const socketName = `fd-two-turns-${process.pid}`;
  const sessions = new TmuxSessionHost({ socketName });
  let settingsPath: string;
  try {
    settingsPath = await writeHookSettings(
      join(options.home, "sessions", sessionId),
      twoTurnsSettings({ nodePath: options.nodePath ?? process.execPath, hookScriptPath }),
    );
  } catch (error) {
    await server.stop();
    throw error;
  }
  const { token, stops } = await driveTwoTurns({
    claude: new ClaudeCli({ sessions }),
    sessions,
    events: server,
    closeEvents: () => server.stop(),
    name: socketName,
    cwd: options.cwd,
    session: { sessionId, model: options.model },
    startOptions: { settingsPath, env: { FLOWDECK_SOCK: socketPath } },
    turnTimeoutMs: options.timeoutMs ?? 90_000,
  });
  const transcriptPath = String(stops[1].payload["transcript_path"]);
  return { sessionId, token, transcriptPath, stops, socketName };
}

async function main(): Promise<void> {
  const home = process.env["FLOWDECK_HOME"] ?? join(homedir(), ".flowdeck");
  const target = process.argv[2];
  const cwd = target ?? (await mkdtemp(join(tmpdir(), "fd-two-turns-")));
  try {
    const { token, transcriptPath } = await runTwoTurns({ home, cwd, model: "haiku" });
    process.stdout.write(`${token}\n${transcriptPath}\n`);
  } finally {
    if (target === undefined) await rm(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
