import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCli } from "../adapters/claude/claude-cli.js";
import {
  ClaudeUserConnectors,
  writeSessionMcpConfig,
} from "../adapters/claude/claude-connectors.js";
import { parseTranscriptTurns } from "../adapters/claude/transcript-turns.js";
import { TranscriptUsage } from "../adapters/claude/transcript-usage.js";
import { CliWaiter, stdinLines } from "./cli-waiter.js";
import { HookSocketServer } from "../adapters/hook-socket/hook-socket-server.js";
import { openClaudeSession } from "../adapters/claude/claude-session.js";
import { GitFolderState } from "../adapters/git/git-state.js";
import { GitWorktree } from "../adapters/git/worktree.js";
import { NodeFileSystem } from "../adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../adapters/process/process-runner.js";
import { SqliteFlowStore } from "../adapters/sqlite/flows.js";
import { openDatabase } from "../adapters/sqlite/open-database.js";
import { SqliteStore } from "../adapters/sqlite/sqlite-store.js";
import { assertSessionName, TmuxSessionHost } from "../adapters/tmux/tmux-session-host.js";
import type { BuildResult } from "../core/compiler/build.js";
import { buildFlow, buildVersion } from "../core/compiler/build-version.js";
import { resolveConnectors, type McpServer } from "../core/compiler/connectors.js";
import type { HookPaths } from "../core/compiler/hook-settings.js";
import { FlowParseError, parseFlow, type BuildConfig, type Flow } from "../core/flow/schema.js";
import type { VariableValues } from "../core/flow/variables.js";
import {
  execute,
  loadBuild,
  needsClaude,
  noClaude,
  runMcpConfigPath,
  runSocketPath,
  type LoadedBuild,
  type OpenedSession,
  type OpenSessionOptions,
} from "../core/run/execute.js";
import { storedAuto, storedFlags } from "../core/run/options.js";
import { BuildRunningError } from "../core/run/store.js";
import { decideResume, type TranscriptTurn } from "../core/run/resume.js";
import type { TurnEvents } from "../core/run/turns.js";
import type { ConnectorSource } from "../ports/connector-source.js";
import type { FileSystem } from "../ports/file-system.js";
import type { FlowStore } from "../ports/flow-store.js";
import type { GitState } from "../ports/git-state.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { Store } from "../ports/store.js";
import type { PermissionSource } from "../ports/permission-source.js";
import type { UsageSource } from "../ports/usage-source.js";
import type { Waiter } from "../ports/waiter.js";
import type { Worktree } from "../ports/worktree.js";

export type CliDeps = {
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  fs: FileSystem;
  scripts: ProcessRunner;
  waiter: Waiter;
  startEvents(
    socketPath: string,
  ): Promise<{ events: TurnEvents; permissions?: PermissionSource; stop(): Promise<void> }>;
  openSession(options: OpenSessionOptions): Promise<OpenedSession>;
  usage?: UsageSource;
  hooks: HookPaths;
  connectors: ConnectorSource;
  openStore(path: string): { runs: Store; flows: FlowStore };
  transcriptTurns(claudeSessionId: string): Promise<TranscriptTurn[]>;
  gitState: GitState;
  worktree: Worktree;
  newId: () => string;
  onInterrupt?(handler: (exitCode: number) => void): () => void;
  now?: () => number;
};

const buildOptions =
  "--name <build-name> [--repo <repo>] [--base <branch>] [--var <name=value>]...";

const usage = [
  "Usage:",
  `  flowdeck build <flow.json> ${buildOptions}`,
  `  flowdeck build --flow <id> --version <n> ${buildOptions}`,
  "  flowdeck run <build-name> [--session <fd-name>] [--model <model>] [--auto]",
  "  flowdeck resume <id> [--auto | --no-auto]",
];
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));

class UsageError extends Error {}

const isUsageError = (error: unknown) =>
  error instanceof UsageError ||
  (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const flowdeckHome = (env: CliDeps["env"]) => env["FLOWDECK_HOME"] ?? join(homedir(), ".flowdeck");

const storePath = (env: CliDeps["env"]) => join(flowdeckHome(env), "flowdeck.db");

const report = (result: BuildResult, deps: CliDeps): number => {
  if (!result.ok) {
    for (const error of result.errors) deps.stderr(`${error.rule}: ${error.message}`);
    return 2;
  }
  deps.stdout(`hash ${result.hash}`);
  deps.stdout(`dir ${result.dir}`);
  return 0;
};

function splitVars(vars: readonly string[]): [string, string][] {
  return vars.map((entry) => {
    const at = entry.indexOf("=");
    if (at <= 0) throw new UsageError();
    return [entry.slice(0, at), entry.slice(at + 1)];
  });
}

function variableValues(
  vars: readonly [string, string][],
  buildConfig: BuildConfig | undefined,
): { values: VariableValues } | { error: string } {
  const values: Record<string, string | boolean> = {};
  for (const [name, text] of vars) {
    const declared = buildConfig?.variables.find((variable) => variable.name === name);
    if (buildConfig !== undefined && declared === undefined) {
      const names = buildConfig.variables.map((variable) => variable.name);
      return {
        error: `build-values: ${name} is not a variable of this blueprint; it declares ${names.length === 0 ? "none" : names.join(", ")}.`,
      };
    }
    if (declared?.kind !== "yesno") {
      values[name] = text;
    } else if (text === "yes" || text === "no") {
      values[name] = text === "yes";
    } else {
      return {
        error: `build-values: ${name} is a yes/no variable; give yes or no, not "${text}".`,
      };
    }
  }
  return { values };
}

async function buildCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      flow: { type: "string" },
      version: { type: "string" },
      name: { type: "string" },
      repo: { type: "string" },
      base: { type: "string" },
      var: { type: "string", multiple: true },
    },
  });
  const byVersion = values.flow !== undefined || values.version !== undefined;
  const version = Number(values.version);
  const [flowPath, ...rest] = positionals;
  const misused = byVersion
    ? values.flow === undefined || positionals.length > 0 || !Number.isInteger(version)
    : flowPath === undefined || rest.length > 0;
  if (misused || values.name === undefined) throw new UsageError();
  const vars = splitVars(values.var ?? []);
  const { runs, flows } = deps.openStore(storePath(deps.env));
  const buildDeps = {
    ...deps,
    home: flowdeckHome(deps.env),
    store: runs,
    flows,
  };
  let flow: Flow | undefined;
  if (!byVersion) {
    try {
      flow = parseFlow(JSON.parse(await deps.fs.readFile(flowPath ?? "")));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof FlowParseError)) throw error;
      deps.stderr(`${flowPath}: ${error.message}`);
      return 2;
    }
  }
  const ref = { flowId: values.flow ?? "", version };
  const buildConfig = (flow ?? flows.load(ref)?.flow)?.session.buildConfig;
  const parsed = variableValues(vars, buildConfig);
  if ("error" in parsed) {
    deps.stderr(parsed.error);
    return 2;
  }
  const request = {
    name: values.name,
    values: parsed.values,
    ...(values.repo === undefined ? {} : { repo: values.repo }),
    ...(values.base === undefined ? {} : { base: values.base }),
  };
  const result =
    flow === undefined
      ? await buildVersion(ref, request, buildDeps)
      : await buildFlow(flow, request, buildDeps);
  return report(result, deps);
}

const executeDeps = (deps: CliDeps, store: Store) => ({ ...deps, store, onChange: deps.stdout });

const writeLines = (write: (line: string) => void, text: string) => {
  for (const line of text.split("\n")) write(line);
};

async function connectorsOrReport(
  manifest: LoadedBuild,
  deps: CliDeps,
): Promise<Record<string, McpServer> | undefined> {
  const connectors = await resolveConnectors(manifest.session.connectors, deps.connectors);
  if (connectors.ok) return connectors.servers;
  for (const error of connectors.errors) deps.stderr(`${error.rule}: ${error.message}`);
  return undefined;
}

async function runCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      session: { type: "string" },
      model: { type: "string" },
      auto: { type: "boolean" },
    },
  });
  const [buildName, ...rest] = positionals;
  if (buildName === undefined || rest.length > 0) throw new UsageError();
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
  const store = deps.openStore(storePath(deps.env)).runs;
  const built = store.findBuildByName(buildName) ?? store.findBuild(buildName);
  if (built === undefined) {
    deps.stderr(`No build named ${buildName}`);
    return 2;
  }
  if (built.deletedAt !== null) {
    deps.stderr(`Build ${built.name ?? buildName} was deleted.`);
    return 2;
  }
  if (built.name === null) {
    deps.stderr(
      "This build was made before builds had names and a workspace. Make a new build from this blueprint to run it.",
    );
    return 2;
  }
  const loaded = await loadBuild(built.id, { fs: deps.fs, store });
  if (loaded.kind === "error") {
    writeLines(deps.stderr, loaded.message);
    return 2;
  }
  const manifest = loaded.build;
  const cwd = manifest.worktree;
  if (cwd === undefined) {
    deps.stderr(`Working folder not found for build ${buildName}`);
    return 2;
  }
  const servers = await connectorsOrReport(manifest, deps);
  if (servers === undefined) return 2;
  const claudeSessionId = randomUUID();
  let run;
  try {
    run = store.createRun({
      buildDir: built.dir,
      inputs: { ...values },
      nodeIds: manifest.nodes.map((node) => node.id),
      session: { tmuxName: sessionName, cwd, claudeSessionId },
      buildId: built.id,
    });
  } catch (error) {
    if (!(error instanceof BuildRunningError)) throw error;
    deps.stderr(`Build ${buildName} has a run left running. Stop or resume it first.`);
    return 2;
  }
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
            buildDir: built.dir,
            layout: manifest.layout,
            model: values.model ?? manifest.session.model,
            socketPath,
            cwd,
            claudeSessionId,
            hooks: deps.hooks,
            ...(await writeSessionMcpConfig(
              deps.fs,
              runMcpConfigPath(flowdeckHome(deps.env), run.id),
              servers,
            )),
          })
        : noClaude,
  });
}

async function resumeCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    allowNegative: true,
    options: { auto: { type: "boolean" } },
  });
  const [runId, ...rest] = positionals;
  if (runId === undefined || rest.length > 0) throw new UsageError();
  const store = deps.openStore(storePath(deps.env)).runs;
  const run = store.findRun(runId);
  if (run === undefined) {
    deps.stderr(`no run ${runId}`);
    return 1;
  }
  if (run.status !== "running") {
    deps.stderr(`run ${runId} already ${run.status}`);
    return 0;
  }
  const loaded = await loadBuild(run.buildId ?? "", { fs: deps.fs, store });
  if (loaded.kind === "error") {
    writeLines(deps.stderr, loaded.message);
    return 2;
  }
  const manifest = loaded.build;
  const servers = await connectorsOrReport(manifest, deps);
  if (servers === undefined) return 2;
  const { tmuxName: sessionName, cwd, claudeSessionId } = run.session;
  const socketPath = `${flowdeckHome(deps.env)}/sockets/${sessionName}.sock`;
  const model = run.inputs["model"];
  const sessionRecorded = store.events(runId).some((event) => event.kind === "sent");
  const opened = needsClaude(manifest)
    ? await deps.openSession({
        sessionName,
        buildDir: run.buildDir,
        layout: manifest.layout,
        model: typeof model === "string" ? model : manifest.session.model,
        socketPath,
        cwd,
        claudeSessionId,
        hooks: deps.hooks,
        ...(await writeSessionMcpConfig(
          deps.fs,
          runMcpConfigPath(flowdeckHome(deps.env), runId),
          servers,
        )),
        ...(sessionRecorded ? { attach: true } : {}),
      })
    : noClaude;
  return execute(executeDeps(deps, store), {
    store,
    runId,
    manifest,
    cwd,
    auto: values.auto ?? storedAuto(run.inputs),
    flags: storedFlags(run.inputs, manifest),
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
    gitState: new GitFolderState(),
    worktree: new GitWorktree(),
    newId: randomUUID,
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
      return { events: server, permissions: server, stop: () => server.stop() };
    },
    usage: new TranscriptUsage({
      findTranscript: (id) => new ClaudeCli({ sessions: new TmuxSessionHost() }).findTranscript(id),
    }),
    openSession: async (options) => {
      const sessions = new TmuxSessionHost({ socketName: options.sessionName });
      return openClaudeSession(options, {
        sessions,
        claude: new ClaudeCli({ sessions }),
        sessionId: options.claudeSessionId,
      });
    },
    hooks: { nodePath: process.execPath, hookScriptPath },
    connectors: new ClaudeUserConnectors(),
    openStore: (path) => {
      const db = openDatabase({ path });
      return { runs: new SqliteStore({ db }), flows: new SqliteFlowStore({ db }) };
    },
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
