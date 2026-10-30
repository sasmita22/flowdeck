import type { Manifest } from "../compiler/lower.js";
import { verify, type VerifyFileSystem } from "../compiler/verify.js";
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
  attach?: boolean;
};

export type OpenedSession = {
  sessionId: string;
  session: { ensureStarted(): Promise<void> };
  prompts: { sendPrompt(text: string): Promise<void> };
  stop(): Promise<void>;
};

export type ExecuteDeps = {
  fs: VerifyFileSystem;
  scripts: RunnerDeps["scripts"];
  waiter: HumanWaiter;
  startEvents(socketPath: string): Promise<{ events: TurnEvents; stop(): Promise<void> }>;
  openSession(options: OpenSessionOptions): Promise<OpenedSession>;
  store: Store;
  onChange(line: string): void;
  onInterrupt?(handler: (exitCode: number) => void): () => void;
  now?: () => number;
};

export type RunEnvironment = Omit<ExecuteDeps, "store" | "onChange" | "onInterrupt">;

export type LoadedBuild = Manifest & { hash: string };

export type LoadBuildResult =
  { kind: "loaded"; build: LoadedBuild } | { kind: "error"; message: string };

export type Execution = {
  store: Store;
  runId: string;
  manifest: LoadedBuild;
  cwd: string;
  auto: boolean;
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
  const problems = structureProblems(manifest.nodes);
  if (problems.length > 0) return { kind: "error", message: new StructureError(problems).message };
  return { kind: "loaded", build: manifest };
}

export const needsClaude = (manifest: LoadedBuild) =>
  manifest.nodes.some((node) => node.type === "prompt" || node.type === "agent");

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

export async function execute(deps: ExecuteDeps, execution: Execution): Promise<number> {
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
      onChange: (line) => deps.onChange(line),
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
