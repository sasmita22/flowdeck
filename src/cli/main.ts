import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCli } from "../adapters/claude/claude-cli.js";
import { parseTranscriptTurns } from "../adapters/claude/transcript-turns.js";
import { CliWaiter, stdinLines } from "./cli-waiter.js";
import { openClaudeSession } from "./claude-session.js";
import { HookSocketServer } from "../adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../adapters/process/process-runner.js";
import { SqliteStore } from "../adapters/sqlite/sqlite-store.js";
import { assertSessionName, TmuxSessionHost } from "../adapters/tmux/tmux-session-host.js";
import { build } from "../core/compiler/build.js";
import type { Manifest } from "../core/compiler/lower.js";
import { verify } from "../core/compiler/verify.js";
import { FlowParseError, parseFlow } from "../core/flow/schema.js";
import {
  decideResume,
  type ResumeAction,
  type ResumeActions,
  type TranscriptTurn,
} from "../core/run/resume.js";
import { Runner, StructureError, structureProblems } from "../core/run/runner.js";
import type { TurnEndEvent, TurnEvents } from "../core/run/turns.js";
import type { FileSystem } from "../ports/file-system.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { RunStatus, Store } from "../ports/store.js";
import type { Waiter } from "../ports/waiter.js";

export type OpenSessionOptions = {
  sessionName: string;
  buildDir: string;
  model: string;
  socketPath: string;
  cwd: string;
  claudeSessionId: string;
  attach?: boolean;
};

export type OpenedSession = {
  sessionId: string;
  session: { ensureStarted(): Promise<void> };
  prompts: { sendPrompt(text: string): Promise<void> };
  stop(): Promise<void>;
};

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
const maxSocketPath = 104;
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));

class UsageError extends Error {}

const isUsageError = (error: unknown) =>
  error instanceof UsageError ||
  (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const flowdeckHome = (env: CliDeps["env"]) => env["FLOWDECK_HOME"] ?? join(homedir(), ".flowdeck");

const storePath = (env: CliDeps["env"]) => join(flowdeckHome(env), "flowdeck.db");

const socketPathFor = (env: CliDeps["env"], sessionName: string) =>
  join(flowdeckHome(env), "sockets", `${sessionName}.sock`);

const noClaude: OpenedSession = {
  sessionId: "",
  session: {
    ensureStarted: () => Promise.reject(new Error("This build has no prompt nodes to start")),
  },
  prompts: {
    sendPrompt: () => Promise.reject(new Error("This build has no prompt nodes to send")),
  },
  stop: async () => undefined,
};

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

type LoadedBuild = Manifest & { hash: string };

async function loadBuild(buildDir: string, deps: CliDeps): Promise<LoadedBuild | undefined> {
  const verified = await verify(buildDir, { fs: deps.fs });
  if (!verified.ok) {
    for (const { path, problem } of verified.problems) deps.stderr(`${path}: ${problem}`);
    return undefined;
  }
  const manifest = JSON.parse(
    await deps.fs.readFile(join(buildDir, "manifest.json")),
  ) as LoadedBuild;
  const problems = structureProblems(manifest.nodes);
  if (problems.length > 0) {
    deps.stderr(new StructureError(problems).message);
    return undefined;
  }
  return manifest;
}

const needsClaude = (manifest: LoadedBuild) =>
  manifest.nodes.some((node) => node.type === "prompt" || node.type === "agent");

type Execution = {
  store: Store;
  runId: string;
  manifest: LoadedBuild;
  cwd: string;
  auto: boolean;
  socketPath: string;
  open(): Promise<OpenedSession>;
  actions?(): Promise<ResumeActions>;
};

type ResumeRead = { actions: ResumeActions; stop?: TurnEndEvent };

async function readUntilNoStop(
  events: TurnEvents,
  sessionId: string,
  read: () => Promise<ResumeActions>,
): Promise<ResumeRead> {
  let stops = 0;
  let stop: TurnEndEvent | undefined;
  const unsubscribe = events.subscribe("Stop", sessionId, (event) => {
    stops++;
    stop = event;
  });
  try {
    for (;;) {
      const stopsBefore = stops;
      const actions = await read();
      if (stops === stopsBefore) return stop === undefined ? { actions } : { actions, stop };
    }
  } finally {
    unsubscribe();
  }
}

function completeWaitWith({ actions, stop }: ResumeRead): ResumeActions {
  if (stop === undefined) return actions;
  const message = stop.payload["last_assistant_message"];
  const complete: ResumeAction =
    typeof message === "string" ? { kind: "complete", stopMessage: message } : { kind: "complete" };
  return Object.fromEntries(
    Object.entries(actions).map(([nodeId, action]) => [
      nodeId,
      action.kind === "wait" ? complete : action,
    ]),
  );
}

async function execute(deps: CliDeps, execution: Execution): Promise<number> {
  const { store, runId, manifest, cwd, auto, socketPath } = execution;
  const events = await deps.startEvents(socketPath);
  let opened: OpenedSession | undefined;
  let stopping: Promise<void> | undefined;
  const stopAll = () =>
    (stopping ??= (async () => {
      try {
        await opened?.stop();
      } finally {
        await events.stop();
      }
    })());
  let stopListening: () => void = () => undefined;
  let wasInterrupted = false;
  const interrupted = new Promise<number>((resolve) => {
    if (deps.onInterrupt) {
      stopListening = deps.onInterrupt((code) => {
        wasInterrupted = true;
        void stopAll().then(() => resolve(code));
      });
    }
  });
  let status: Exclude<RunStatus, "running"> = "failed";
  try {
    opened = await execution.open();
    const actions =
      execution.actions === undefined
        ? {}
        : completeWaitWith(
            await readUntilNoStop(events.events, opened.sessionId, execution.actions),
          );
    const session = opened;
    const whileRunning = async <T>(step: () => Promise<T>): Promise<T> => {
      if (stopping) throw new Error("The run was stopped");
      return step();
    };
    const finished = new Runner({
      prompts: { sendPrompt: (text) => whileRunning(() => session.prompts.sendPrompt(text)) },
      session: {
        ensureStarted: () =>
          whileRunning(async () => {
            await session.session.ensureStarted();
            if (stopping) {
              await session.stop();
              throw new Error("The run was stopped");
            }
          }),
      },
      events: events.events,
      scripts: {
        run: (command, args, cwd) => whileRunning(() => deps.scripts.run(command, args, cwd)),
      },
      waiter: deps.waiter,
      auto,
      onChange: (line) => deps.stdout(line),
      cwd,
      sessionId: opened.sessionId,
      store,
      runId,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
      .run(manifest, { actions })
      .then((result) => (result.outcome === "done" ? 0 : 1));
    const code = await Promise.race([finished, interrupted]);
    if (code === 0) status = "done";
    return code;
  } finally {
    stopListening();
    await stopAll();
    store.finishRun(runId, wasInterrupted ? "stopped" : status);
  }
}

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
  const socketPath = socketPathFor(deps.env, sessionName);
  if (socketPath.length > maxSocketPath) {
    deps.stderr(`Socket path "${socketPath}" is longer than ${maxSocketPath} characters`);
    return 2;
  }
  const manifest = await loadBuild(buildDir, deps);
  if (manifest === undefined) return 2;
  const store = deps.openStore(storePath(deps.env));
  const claudeSessionId = randomUUID();
  const run = store.createRun({
    buildDir,
    inputs: { ...values },
    nodeIds: manifest.nodes.map((node) => node.id),
    session: { tmuxName: sessionName, cwd, claudeSessionId },
  });
  deps.stderr(`run ${run.id}`);
  return execute(deps, {
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
  const manifest = await loadBuild(run.buildDir, deps);
  if (manifest === undefined) return 2;
  const { tmuxName: sessionName, cwd, claudeSessionId } = run.session;
  const socketPath = socketPathFor(deps.env, sessionName);
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
  return execute(deps, {
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
