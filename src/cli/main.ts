import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCli } from "../adapters/claude/claude-cli.js";
import { CliWaiter, stdinLines } from "./cli-waiter.js";
import { openClaudeSession } from "./claude-session.js";
import { HookSocketServer } from "../adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../adapters/process/process-runner.js";
import { assertSessionName, TmuxSessionHost } from "../adapters/tmux/tmux-session-host.js";
import { build } from "../core/compiler/build.js";
import type { Manifest } from "../core/compiler/lower.js";
import { verify } from "../core/compiler/verify.js";
import { FlowParseError, parseFlow } from "../core/flow/schema.js";
import { Runner, unsupportedNodes, UnsupportedNodesError } from "../core/run/runner.js";
import type { TurnEvents } from "../core/run/turns.js";
import type { FileSystem } from "../ports/file-system.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { Waiter } from "../ports/waiter.js";

export type OpenSessionOptions = {
  sessionName: string;
  buildDir: string;
  model: string;
  socketPath: string;
  cwd: string;
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
  onInterrupt?(handler: (exitCode: number) => void): () => void;
};

const usage = [
  "Usage:",
  "  flowdeck build <flow.json>",
  "  flowdeck run <buildDir> --cwd <repo> [--session <fd-name>] [--model <model>] [--auto]",
];
const maxSocketPath = 104;
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));

class UsageError extends Error {}

const isUsageError = (error: unknown) =>
  error instanceof UsageError ||
  (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const flowdeckHome = (env: CliDeps["env"]) => env["FLOWDECK_HOME"] ?? join(homedir(), ".flowdeck");

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
  const socketPath = join(flowdeckHome(deps.env), "sockets", `${sessionName}.sock`);
  if (socketPath.length > maxSocketPath) {
    deps.stderr(`Socket path "${socketPath}" is longer than ${maxSocketPath} characters`);
    return 2;
  }
  const verified = await verify(buildDir, { fs: deps.fs });
  if (!verified.ok) {
    for (const { path, problem } of verified.problems) deps.stderr(`${path}: ${problem}`);
    return 2;
  }
  const manifest = JSON.parse(
    await deps.fs.readFile(join(buildDir, "manifest.json")),
  ) as Manifest & {
    hash: string;
  };
  const unsupported = unsupportedNodes(manifest.nodes);
  if (unsupported.length > 0) {
    deps.stderr(new UnsupportedNodesError(unsupported).message);
    return 2;
  }
  const needsClaude = manifest.nodes.some(
    (node) => node.type === "prompt" || node.type === "agent",
  );
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
  const interrupted = new Promise<number>((resolve) => {
    if (deps.onInterrupt) {
      stopListening = deps.onInterrupt((code) => {
        void stopAll().then(() => resolve(code));
      });
    }
  });
  try {
    opened = needsClaude
      ? await deps.openSession({
          sessionName,
          buildDir,
          model: values.model ?? manifest.session.model,
          socketPath,
          cwd,
        })
      : noClaude;
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
      auto: values.auto ?? false,
      onChange: (line) => deps.stdout(line),
      cwd,
      sessionId: opened.sessionId,
    })
      .run(manifest)
      .then((result) => (result.outcome === "done" ? 0 : 1));
    return await Promise.race([finished, interrupted]);
  } finally {
    stopListening();
    await stopAll();
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "build") return await buildCommand(args, deps);
    if (command === "run") return await runCommand(args, deps);
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
        sessionId: randomUUID(),
      });
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
