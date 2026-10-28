import type { Manifest, ManifestNode } from "../compiler/lower.js";
import { agentOutcome, agentTurnText, agentType } from "../nodes/agent/execute.js";
import { scriptOutcome } from "../nodes/script/execute.js";
import { move, type NodeState } from "./state.js";
import { waitForTurnEnd, type TurnEvents } from "./turns.js";

export type RunnableManifest = Pick<Manifest, "nodes"> & { hash: string };

export type ScriptResult = { code: number | null; stdout: string; stderr: string };

export type RunnerDeps = {
  prompts: { sendPrompt(text: string): Promise<void> };
  session: { ensureStarted(): Promise<void> };
  events: TurnEvents;
  scripts: { run(command: string, args: readonly string[], cwd: string): Promise<ScriptResult> };
  onChange?: (line: string) => void;
  cwd: string;
  sessionId: string;
  turnTimeoutMs?: number;
};

export type RunResult = {
  outcome: "done" | "failed";
  failedNode?: string;
  states: Record<string, NodeState>;
};

type ScriptSettings = { command: string; args?: string[] };

const defaultTurnTimeoutMs = 600_000;
const runnable = new Set<ManifestNode["type"]>(["prompt", "agent", "script"]);
const skipped = new Set<ManifestNode["type"]>(["trigger", "output"]);

export function unsupportedNodes(nodes: readonly ManifestNode[]): ManifestNode[] {
  return nodes.filter((node) => !runnable.has(node.type) && !skipped.has(node.type));
}

export class UnsupportedNodesError extends Error {
  constructor(nodes: readonly ManifestNode[]) {
    super(`Unsupported node types: ${nodes.map((node) => `${node.id} (${node.type})`).join(", ")}`);
    this.name = "UnsupportedNodesError";
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const outputLines = (text: string) =>
  text === ""
    ? []
    : text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `  ${line}`);

const exitReason = (code: number | null) =>
  code === null ? "killed by a signal" : `exit code ${code}`;

type SubagentStops = { seen: string[]; unsubscribe: () => void };

function recordSubagentStopsUntilStop(events: TurnEvents, sessionId: string): SubagentStops {
  const seen: string[] = [];
  const stopRecording = events.subscribe("SubagentStop", sessionId, (event) => {
    const type = event.payload["agent_type"];
    if (typeof type === "string") seen.push(type);
  });
  const stopWatching = events.subscribe("Stop", sessionId, stopRecording);
  return {
    seen,
    unsubscribe: () => {
      stopRecording();
      stopWatching();
    },
  };
}

export class Runner {
  private readonly deps: RunnerDeps;
  private readonly emit: (line: string) => void;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.emit = deps.onChange ?? (() => undefined);
  }

  async run(manifest: RunnableManifest): Promise<RunResult> {
    const unsupported = unsupportedNodes(manifest.nodes);
    if (unsupported.length > 0) throw new UnsupportedNodesError(unsupported);
    const nodes = manifest.nodes.filter((node) => runnable.has(node.type));
    const states: Record<string, NodeState> = Object.fromEntries(
      nodes.map((node) => [node.id, "waiting" as NodeState]),
    );
    let started = false;
    const ensureStarted = async () => {
      if (started) return;
      await this.deps.session.ensureStarted();
      started = true;
    };
    for (const node of nodes) {
      const failure =
        node.type === "prompt"
          ? await this.runPrompt(node, manifest.hash, states, ensureStarted)
          : node.type === "agent"
            ? await this.runAgent(node, manifest.hash, states, ensureStarted)
            : await this.runScript(node, states);
      if (failure !== undefined) {
        states[node.id] = move(states[node.id] ?? "waiting", "failed");
        this.emit(`${node.id} failed: ${failure}`);
        return { outcome: "failed", failedNode: node.id, states };
      }
      this.emit(`${node.id} done`);
    }
    return { outcome: "done", states };
  }

  private async runPrompt(
    node: ManifestNode,
    hash: string,
    states: Record<string, NodeState>,
    ensureStarted: () => Promise<void>,
  ): Promise<string | undefined> {
    states[node.id] = move("waiting", "sent");
    this.emit(`${node.id} started`);
    try {
      await ensureStarted();
      const turnEnd = waitForTurnEnd(
        this.deps.events,
        this.deps.sessionId,
        this.deps.turnTimeoutMs ?? defaultTurnTimeoutMs,
      );
      turnEnd.catch(() => undefined);
      await this.deps.prompts.sendPrompt(`/${hash}:${node.id}`);
      await turnEnd;
    } catch (error) {
      return messageOf(error);
    }
    states[node.id] = move("sent", "done");
    return undefined;
  }

  private async runAgent(
    node: ManifestNode,
    hash: string,
    states: Record<string, NodeState>,
    ensureStarted: () => Promise<void>,
  ): Promise<string | undefined> {
    states[node.id] = move("waiting", "sent");
    this.emit(`${node.id} started`);
    let subagents: SubagentStops | undefined;
    try {
      await ensureStarted();
      subagents = recordSubagentStopsUntilStop(this.deps.events, this.deps.sessionId);
      const turnEnd = waitForTurnEnd(
        this.deps.events,
        this.deps.sessionId,
        this.deps.turnTimeoutMs ?? defaultTurnTimeoutMs,
      );
      turnEnd.catch(() => undefined);
      await this.deps.prompts.sendPrompt(agentTurnText(hash, node.id));
      await turnEnd;
    } catch (error) {
      return messageOf(error);
    } finally {
      subagents?.unsubscribe();
    }
    if (agentOutcome(subagents.seen, hash, node.id) === "failed") {
      return `no SubagentStop for ${agentType(hash, node.id)}`;
    }
    states[node.id] = move("sent", "done");
    return undefined;
  }

  private async runScript(
    node: ManifestNode,
    states: Record<string, NodeState>,
  ): Promise<string | undefined> {
    const { command, args } = node.settings as ScriptSettings;
    states[node.id] = move("waiting", "running");
    this.emit(`${node.id} started`);
    for (let attempt = 1; ; attempt++) {
      let result: ScriptResult;
      try {
        result = await this.deps.scripts.run(command, args ?? [], this.deps.cwd);
      } catch (error) {
        return messageOf(error);
      }
      for (const line of [...outputLines(result.stdout), ...outputLines(result.stderr)]) {
        this.emit(line);
      }
      const outcome = scriptOutcome(result.code, attempt);
      if (outcome === "failed") return exitReason(result.code);
      if (outcome === "done") {
        states[node.id] = move("running", "done");
        return undefined;
      }
      states[node.id] = move("running", "waiting");
      this.emit(`${node.id} retry`);
      states[node.id] = move("waiting", "running");
    }
  }
}
