import type { Manifest } from "../compiler/lower.js";
import type { HookPaths } from "../compiler/hook-settings.js";
import { verify, type VerifyFileSystem } from "../compiler/verify.js";
import { costOf, type UsageReader } from "./budget.js";
import { agentNodes, chargeUsage } from "./cost.js";
import type { PermissionAsks } from "./permission.js";
import type { ResumeAction, ResumeActions } from "./resume.js";
import { Runner, StructureError, structureProblems, type RunnerDeps } from "./runner.js";
import type { RunStatus, Store } from "./store.js";
import type { TurnEndEvent, TurnEvents } from "./turns.js";
import type { HumanWaiter } from "./wait.js";

export type OpenSessionOptions = {
  sessionName: string;
  buildDir: string;
  model: string;
  socketPath: string;
  cwd: string;
  claudeSessionId: string;
  hooks: HookPaths;
  mcpConfigPath?: string;
  attach?: boolean;
};

export type OpenedSession = {
  sessionId: string;
  session: { ensureStarted(): Promise<void> };
  prompts: RunnerDeps["prompts"];
  stop(): Promise<void>;
};

export type ExecuteDeps = {
  fs: VerifyFileSystem;
  scripts: {
    run(
      command: string,
      args: readonly string[],
      cwd: string,
      signal?: AbortSignal,
    ): ReturnType<RunnerDeps["scripts"]["run"]>;
  };
  waiter: HumanWaiter;
  startEvents(
    socketPath: string,
  ): Promise<{ events: TurnEvents; permissions?: PermissionAsks; stop(): Promise<void> }>;
  openSession(options: OpenSessionOptions): Promise<OpenedSession>;
  store: Store;
  onChange(line: string): void;
  onOutput?: RunnerDeps["onOutput"];
  onInterrupt?(handler: (exitCode: number) => void): () => void;
  now?: () => number;
  usage?: UsageReader;
};

export type RunEnvironment = Omit<ExecuteDeps, "store" | "onChange" | "onOutput" | "onInterrupt">;

export type LoadedBuild = Manifest & { hash: string };

export type LoadBuildResult =
  { kind: "loaded"; build: LoadedBuild } | { kind: "error"; message: string };

export type Execution = {
  store: Store;
  runId: string;
  manifest: LoadedBuild;
  cwd: string;
  auto: boolean;
  flags?: Record<string, boolean>;
  socketPath: string;
  open(): Promise<OpenedSession>;
  actions?(): Promise<ResumeActions>;
};

const maxSocketPath = 104;

export const noClaude: OpenedSession = {
  sessionId: "",
  session: {
    ensureStarted: () => Promise.reject(new Error("This build has no prompt nodes to start")),
  },
  prompts: {
    sendPrompt: () => Promise.reject(new Error("This build has no prompt nodes to send")),
    interrupt: () => Promise.reject(new Error("This build has no prompt nodes to interrupt")),
  },
  stop: async () => undefined,
};

export function runSocketPath(
  home: string,
  sessionName: string,
): { kind: "ok"; path: string } | { kind: "error"; message: string } {
  const path = `${home}/sockets/${sessionName}.sock`;
  return path.length > maxSocketPath
    ? { kind: "error", message: `Socket path "${path}" is longer than ${maxSocketPath} characters` }
    : { kind: "ok", path };
}

export async function loadBuild(
  buildDir: string,
  deps: { fs: VerifyFileSystem },
): Promise<LoadBuildResult> {
  const verified = await verify(buildDir, { fs: deps.fs });
  if (!verified.ok) {
    return {
      kind: "error",
      message: verified.problems.map(({ path, problem }) => `${path}: ${problem}`).join("\n"),
    };
  }
  const manifest = JSON.parse(await deps.fs.readFile(`${buildDir}/manifest.json`)) as LoadedBuild;
  const problems = structureProblems(manifest.nodes, manifest.wires);
  if (problems.length > 0) return { kind: "error", message: new StructureError(problems).message };
  return { kind: "loaded", build: manifest };
}

export const runMcpConfigPath = (home: string, runId: string): string =>
  `${home}/runs/${runId}/mcp.json`;

const checksACondition = (node: LoadedBuild["nodes"][number]) =>
  node.type === "hardstop" && (node.settings as { condition: string }).condition.trim() !== "";

export const needsClaude = (manifest: LoadedBuild) =>
  manifest.nodes.some(
    (node) => node.type === "prompt" || node.type === "agent" || checksACondition(node),
  );

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

const turnTypes = new Set(["prompt", "agent", "fork", "hardstop"]);

export const turnNodeIds = (manifest: Pick<LoadedBuild, "nodes">): Set<string> =>
  new Set(manifest.nodes.filter((node) => turnTypes.has(node.type)).map((node) => node.id));

async function recordSpend(
  store: Store,
  runId: string,
  manifest: LoadedBuild,
  usage: UsageReader | undefined,
  sessionId: string | undefined,
  onChange: (line: string) => void,
): Promise<void> {
  if (usage === undefined || sessionId === undefined || sessionId === "") return;
  try {
    const entries = await usage.entries(sessionId);
    const charges = chargeUsage({
      events: store.events(runId),
      entries,
      turnNodes: turnNodeIds(manifest),
      agentNodes: agentNodes(manifest),
    });
    if (charges.length > 0) store.appendAll(runId, charges);
    store.recordCost(runId, costOf(entries));
  } catch (error) {
    onChange(`cost not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writesUntil(store: Store, stopped: () => boolean): Store {
  return {
    createRun: (run) => store.createRun(run),
    findRun: (id) => store.findRun(id),
    listRuns: () => store.listRuns(),
    events: (id) => store.events(id),
    finishRun: (id, status) => store.finishRun(id, status),
    reopenRun: (id) => store.reopenRun(id),
    recordActivity: (id, entry) => store.recordActivity(id, entry),
    activity: (id) => store.activity(id),
    recordCost: (id, totalCost) => store.recordCost(id, totalCost),
    recordBuild: (build) => store.recordBuild(build),
    findBuild: (hash) => store.findBuild(hash),
    listBuilds: () => store.listBuilds(),
    buildFiles: (hash) => store.buildFiles(hash),
    append(id, nodeId, event) {
      if (!stopped()) store.append(id, nodeId, event);
    },
    appendAll(id, entries) {
      if (!stopped()) store.appendAll(id, entries);
    },
  };
}

export async function execute(deps: ExecuteDeps, execution: Execution): Promise<number> {
  const { store, runId, manifest, cwd, auto, flags = {}, socketPath } = execution;
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
  const scriptsStop = new AbortController();
  const interrupted = new Promise<number>((resolve) => {
    if (deps.onInterrupt) {
      stopListening = deps.onInterrupt((code) => {
        wasInterrupted = true;
        scriptsStop.abort();
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
      prompts: {
        sendPrompt: (text) => whileRunning(() => session.prompts.sendPrompt(text)),
        interrupt: () => whileRunning(() => session.prompts.interrupt()),
      },
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
        run: (command, args, cwd) =>
          whileRunning(() => deps.scripts.run(command, args, cwd, scriptsStop.signal)),
      },
      waiter: deps.waiter,
      files: deps.fs,
      auto,
      flags,
      onChange: (line) => deps.onChange(line),
      ...(deps.onOutput === undefined ? {} : { onOutput: deps.onOutput }),
      cwd,
      sessionId: opened.sessionId,
      store: writesUntil(store, () => wasInterrupted),
      runId,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(events.permissions === undefined ? {} : { permissions: events.permissions }),
      ...(deps.usage === undefined ? {} : { usage: deps.usage }),
      ...(manifest.session.budget === undefined ? {} : { budget: manifest.session.budget }),
    })
      .run(manifest, { actions })
      .then((result) => (result.outcome === "done" ? 0 : 1));
    const code = await Promise.race([finished, interrupted]);
    if (code === 0) status = "done";
    return code;
  } finally {
    stopListening();
    await stopAll();
    await recordSpend(store, runId, manifest, deps.usage, opened?.sessionId, deps.onChange);
    store.finishRun(runId, wasInterrupted ? "stopped" : status);
  }
}
