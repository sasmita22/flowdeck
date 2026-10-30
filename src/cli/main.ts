import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCli } from "../adapters/claude/claude-cli.js";
import { parseTranscriptTurns } from "../adapters/claude/transcript-turns.js";
import { CliWaiter, stdinLines } from "./cli-waiter.js";
import { HookSocketServer } from "../adapters/hook-socket/hook-socket-server.js";
import { openClaudeSession } from "../adapters/claude/claude-session.js";
import { NodeFileSystem } from "../adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../adapters/process/process-runner.js";
import { SqliteStore } from "../adapters/sqlite/sqlite-store.js";
import { assertSessionName, TmuxSessionHost } from "../adapters/tmux/tmux-session-host.js";
import { build } from "../core/compiler/build.js";
import { FlowParseError, parseFlow } from "../core/flow/schema.js";
import {
  execute,
  loadBuild,
  needsClaude,
  noClaude,
  runSocketPath,
  type OpenedSession,
  type OpenSessionOptions,
} from "../core/run/execute.js";
import { decideResume, type TranscriptTurn } from "../core/run/resume.js";
import type { TurnEvents } from "../core/run/turns.js";
import type { FileSystem } from "../ports/file-system.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { Store } from "../ports/store.js";
import type { Waiter } from "../ports/waiter.js";

export type CliDeps = {
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  fs: FileSystem;
  scripts: ProcessRunner;
  waiter: Waiter;
  startEvents(socketPath: string): Promise<{ events: TurnEvents; stop(): Promise<void> }>;
  openSession(options: OpenSessionOptions): Promise<OpenedSession>;
  openStore(path: string): Store;
  transcriptTurns(claudeSessionId: string): Promise<TranscriptTurn[]>;
  onInterrupt?(handler: (exitCode: number) => void): () => void;
  now?: () => number;
};

const usage = [
  "Usage:",
  "  flowdeck build <flow.json>",
  "  flowdeck run <buildDir> --cwd <repo> [--session <fd-name>] [--model <model>] [--auto]",
  "  flowdeck resume <id> [--auto]",
];
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));

class UsageError extends Error {}

const isUsageError = (error: unknown) =>
  error instanceof UsageError ||
  (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const flowdeckHome = (env: CliDeps["env"]) => env["FLOWDECK_HOME"] ?? join(homedir(), ".flowdeck");

const storePath = (env: CliDeps["env"]) => join(flowdeckHome(env), "flowdeck.db");

async function buildCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [flowPath, ...rest] = positionals;
  if (flowPath === undefined || rest.length > 0) throw new UsageError();
  let flow;
  try {
    flow = parseFlow(JSON.parse(await deps.fs.readFile(flowPath)));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof FlowParseError)) throw error;
    deps.stderr(`${flowPath}: ${error.message}`);
    return 2;
  }
  const result = await build(flow, {
    fs: deps.fs,
    home: flowdeckHome(deps.env),
    hooks: { nodePath: process.execPath, hookScriptPath },
  });
  if (!result.ok) {
    for (const error of result.errors) deps.stderr(`${error.rule}: ${error.message}`);
    return 2;
  }
  deps.stdout(`hash ${result.hash}`);
  deps.stdout(`dir ${result.dir}`);
  return 0;
}

const executeDeps = (deps: CliDeps, store: Store) => ({ ...deps, store, onChange: deps.stdout });

const writeLines = (write: (line: string) => void, text: string) => {
  for (const line of text.split("\n")) write(line);
};

async function runCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      session: { type: "string" },
      model: { type: "string" },
      auto: { type: "boolean" },
    },
  });
  const [buildArg, ...rest] = positionals;
  if (buildArg === undefined || rest.length > 0 || values.cwd === undefined) throw new UsageError();
  const buildDir = resolve(buildArg);
  const cwd = resolve(values.cwd);
  const sessionName = values.session ?? `fd-run-${randomUUID().slice(0, 8)}`;
  try {
    assertSessionName(sessionName);
  } catch (error) {
    deps.stderr(messageOf(error));
    return 2;
  }
  const socket = runSocketPath(flowdeckHome(deps.env), sessionName);
  if (socket.kind === "error") {
    deps.stderr(socket.message);
    return 2;
  }
  const socketPath = socket.path;
  const loaded = await loadBuild(buildDir, deps);
  if (loaded.kind === "error") {
    writeLines(deps.stderr, loaded.message);
    return 2;
  }
  const manifest = loaded.build;
  const store = deps.openStore(storePath(deps.env));
  const claudeSessionId = randomUUID();
  const run = store.createRun({
    buildDir,
    inputs: { ...values },
    nodeIds: manifest.nodes.map((node) => node.id),
    session: { tmuxName: sessionName, cwd, claudeSessionId },
  });
  deps.stderr(`run ${run.id}`);
  return execute(executeDeps(deps, store), {
    store,
    runId: run.id,
    manifest,
    cwd,
    auto: values.auto ?? false,
    socketPath,
    open: async () =>
      needsClaude(manifest)
        ? deps.openSession({
            sessionName,
            buildDir,
            model: values.model ?? manifest.session.model,
            socketPath,
            cwd,
            claudeSessionId,
          })
        : noClaude,
  });
}

async function resumeCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { auto: { type: "boolean" } },
  });
  const [runId, ...rest] = positionals;
  if (runId === undefined || rest.length > 0) throw new UsageError();
  const store = deps.openStore(storePath(deps.env));
  const run = store.findRun(runId);
  if (run === undefined) {
    deps.stderr(`no run ${runId}`);
    return 1;
  }
  if (run.status !== "running") {
    deps.stderr(`run ${runId} already ${run.status}`);
    return 0;
  }
  const loaded = await loadBuild(run.buildDir, deps);
  if (loaded.kind === "error") {
    writeLines(deps.stderr, loaded.message);
    return 2;
  }
  const manifest = loaded.build;
  const { tmuxName: sessionName, cwd, claudeSessionId } = run.session;
  const socketPath = `${flowdeckHome(deps.env)}/sockets/${sessionName}.sock`;
  const model = run.inputs["model"];
  const sessionRecorded = store.events(runId).some((event) => event.kind === "sent");
  const opened = needsClaude(manifest)
    ? await deps.openSession({
        sessionName,
        buildDir: run.buildDir,
        model: typeof model === "string" ? model : manifest.session.model,
        socketPath,
        cwd,
        claudeSessionId,
        ...(sessionRecorded ? { attach: true } : {}),
      })
    : noClaude;
  return execute(executeDeps(deps, store), {
    store,
    runId,
    manifest,
    cwd,
    auto: values.auto ?? false,
    socketPath,
    open: async () => opened,
    actions: async () =>
      decideResume({
        manifest,
        events: store.events(runId),
        turns: await deps.transcriptTurns(claudeSessionId),
      }),
  });
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "build") return await buildCommand(args, deps);
    if (command === "run") return await runCommand(args, deps);
    if (command === "resume") return await resumeCommand(args, deps);
    throw new UsageError();
  } catch (error) {
    if (isUsageError(error)) {
      for (const line of usage) deps.stderr(line);
      return 2;
    }
    deps.stderr(messageOf(error));
    return 1;
  }
}

export function realDeps(): CliDeps {
  return {
    env: process.env,
    now: Date.now,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    fs: new NodeFileSystem(),
    scripts: new NodeProcessRunner(),
    waiter: new CliWaiter({
      readLine: stdinLines(process.stdin),
      write: (text) => process.stdout.write(text),
    }),
    onInterrupt: (handler) => {
      const onSigint = () => handler(130);
      const onSigterm = () => handler(143);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      return () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
    },
    startEvents: async (socketPath) => {
      await mkdir(dirname(socketPath), { recursive: true });
      const server = new HookSocketServer({ socketPath });
      await server.start();
      return { events: server, stop: () => server.stop() };
    },
    openSession: async (options) => {
      const sessions = new TmuxSessionHost({ socketName: options.sessionName });
      return openClaudeSession(options, {
        sessions,
        claude: new ClaudeCli({ sessions }),
        sessionId: options.claudeSessionId,
      });
    },
    openStore: (path) => new SqliteStore({ path }),
    transcriptTurns: async (claudeSessionId) => {
      const claude = new ClaudeCli({ sessions: new TmuxSessionHost() });
      const transcript = await claude.findTranscript(claudeSessionId);
      return transcript === undefined
        ? []
        : parseTranscriptTurns(await readFile(transcript, "utf8"));
    },
  };
}

const flushed = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => stream.write("", () => resolve()));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCli(process.argv.slice(2), realDeps()).then(async (code) => {
    await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
    process.exit(code);
  });
}
