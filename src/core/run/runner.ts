import type { Manifest, ManifestNode } from "../compiler/lower.js";
import { agentOutcome, agentTurnText, agentType } from "../nodes/agent/execute.js";
import {
  askOutcome,
  askRequest,
  withAgentContext,
  withPromptContext,
} from "../nodes/ask/execute.js";
import { gateOutcome, gateRequest, gateSkips } from "../nodes/gate/execute.js";
import { hardstopOutcome, hardstopRequest } from "../nodes/hardstop/execute.js";
import { scriptOutcome } from "../nodes/script/execute.js";
import { move, type NodeState } from "./state.js";
import { waitForTurnEnd, type TurnEvents } from "./turns.js";
import type { HumanDecision, HumanOutcome, HumanWaiter, WaitReply, WaitRequest } from "./wait.js";

export type RunnableManifest = Pick<Manifest, "nodes"> & { hash: string };

export type ScriptResult = { code: number | null; stdout: string; stderr: string };

export type RunnerDeps = {
  prompts: { sendPrompt(text: string): Promise<void> };
  session: { ensureStarted(): Promise<void> };
  events: TurnEvents;
  scripts: { run(command: string, args: readonly string[], cwd: string): Promise<ScriptResult> };
  waiter: HumanWaiter;
  auto?: boolean;
  onChange?: (line: string) => void;
  cwd: string;
  sessionId: string;
  turnTimeoutMs?: number;
};

export type RunResult = {
  outcome: "done" | "failed";
  failedNode?: string;
  states: Record<string, NodeState>;
  decisions: HumanDecision[];
};

type ScriptSettings = { command: string; args?: string[] };
type GateSettings = Parameters<typeof gateRequest>[1];
type AskSettings = Parameters<typeof askRequest>[1];
type HardstopSettings = Parameters<typeof hardstopRequest>[1];

const defaultTurnTimeoutMs = 600_000;
const runnable = new Set<ManifestNode["type"]>([
  "prompt",
  "agent",
  "script",
  "gate",
  "ask",
  "hardstop",
]);
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
  private decisions: HumanDecision[] = [];
  private pendingAnswers: string[] = [];

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.emit = deps.onChange ?? (() => undefined);
  }

  async run(manifest: RunnableManifest): Promise<RunResult> {
    const unsupported = unsupportedNodes(manifest.nodes);
    if (unsupported.length > 0) throw new UnsupportedNodesError(unsupported);
    this.decisions = [];
    this.pendingAnswers = [];
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
      let failure: string | undefined;
      let doneLine = "done";
      if (node.type === "prompt") {
        failure = await this.runPrompt(node, manifest.hash, states, ensureStarted);
      } else if (node.type === "agent") {
        failure = await this.runAgent(node, manifest.hash, states, ensureStarted);
      } else if (node.type === "script") {
        failure = await this.runScript(node, states);
      } else {
        const outcome = await this.runHuman(node, states);
        if (outcome.status === "failed") failure = outcome.reason;
        else doneLine = outcome.line;
      }
      if (failure !== undefined) {
        states[node.id] = move(states[node.id] ?? "waiting", "failed");
        this.emit(`${node.id} failed: ${failure}`);
        return { outcome: "failed", failedNode: node.id, states, decisions: this.decisions };
      }
      this.emit(`${node.id} ${doneLine}`);
    }
    return { outcome: "done", states, decisions: this.decisions };
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
      await this.deps.prompts.sendPrompt(
        withPromptContext(`/${hash}:${node.id}`, this.takeAnswers()),
      );
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
      await this.deps.prompts.sendPrompt(
        withAgentContext(agentTurnText(hash, node.id), this.takeAnswers()),
      );
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

  private takeAnswers(): string[] {
    const answers = this.pendingAnswers;
    this.pendingAnswers = [];
    return answers;
  }

  private runHuman(node: ManifestNode, states: Record<string, NodeState>): Promise<HumanOutcome> {
    if (node.type === "gate") return this.runGate(node, states);
    if (node.type === "ask") return this.runAsk(node, states);
    return this.runHardstop(node, states);
  }

  private async runGate(
    node: ManifestNode,
    states: Record<string, NodeState>,
  ): Promise<HumanOutcome> {
    const settings = node.settings as GateSettings;
    if (gateSkips(settings, this.deps.auto ?? false)) {
      states[node.id] = move("waiting", "skipped");
      const decision: HumanDecision = { nodeId: node.id, decision: "skipped" };
      this.decisions.push(decision);
      return { status: "done", line: "skipped", decision };
    }
    return this.waitFor(node, states, gateRequest(node.id, settings), (reply) =>
      gateOutcome(node.id, reply),
    );
  }

  private async runAsk(
    node: ManifestNode,
    states: Record<string, NodeState>,
  ): Promise<HumanOutcome> {
    const outcome = await this.waitFor(
      node,
      states,
      askRequest(node.id, node.settings as AskSettings),
      (reply) => askOutcome(node.id, reply),
    );
    if (outcome.status === "done" && outcome.decision.decision === "answered") {
      this.pendingAnswers.push(outcome.decision.answer);
    }
    return outcome;
  }

  private runHardstop(
    node: ManifestNode,
    states: Record<string, NodeState>,
  ): Promise<HumanOutcome> {
    return this.waitFor(
      node,
      states,
      hardstopRequest(node.id, node.settings as HardstopSettings),
      (reply) => hardstopOutcome(node.id, reply),
    );
  }

  private async waitFor(
    node: ManifestNode,
    states: Record<string, NodeState>,
    request: WaitRequest,
    toOutcome: (reply: WaitReply) => HumanOutcome,
  ): Promise<HumanOutcome> {
    states[node.id] = move("waiting", "needs-you");
    let outcome: HumanOutcome;
    try {
      outcome = toOutcome(await this.deps.waiter.wait(request));
    } catch (error) {
      return { status: "failed", reason: messageOf(error) };
    }
    if (outcome.decision !== undefined) this.decisions.push(outcome.decision);
    if (outcome.status === "done") states[node.id] = move("needs-you", "done");
    return outcome;
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
