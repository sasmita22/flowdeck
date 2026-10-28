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
import {
  agentVerdictTurnText,
  capAnswer,
  capRequest,
  malformedAnswer,
  malformedRequest,
  nextStep,
  verdictRequest,
  type LoopAnswer,
  type LoopStep,
} from "../nodes/loop/execute.js";
import { scriptOutcome } from "../nodes/script/execute.js";
import { move, type NodeState } from "./state.js";
import { waitForTurnEnd, type TurnEndEvent, type TurnEvents } from "./turns.js";
import { parseVerdict } from "./verdict.js";
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
type LoopSettings = { condition: string; cap: number; onCap: "ask" | "fail" };

type Failure = { nodeId: string; reason: string };
type StepResult = { failure: Failure } | { failure?: never; reply?: string | undefined };
type TurnResult = { failure: string } | { failure?: never; reply: string | undefined };
type RunContext = {
  hash: string;
  nodes: readonly ManifestNode[];
  states: Record<string, NodeState>;
  ensureStarted: () => Promise<void>;
};

const defaultTurnTimeoutMs = 600_000;
const runnable = new Set<ManifestNode["type"]>([
  "prompt",
  "agent",
  "script",
  "gate",
  "ask",
  "hardstop",
  "loop",
]);

export function structureProblems(nodes: readonly ManifestNode[]): string[] {
  const loops = new Set(nodes.filter((node) => node.type === "loop").map((node) => node.id));
  return nodes.flatMap((node) => {
    const problems: string[] = [];
    if (node.type === "loop") {
      const hasTurn = nodes.some(
        (child) => child.parent === node.id && (child.type === "prompt" || child.type === "agent"),
      );
      if (!hasTurn) problems.push(`${node.id} (loop) has no prompt or agent in its body`);
      if (node.parent !== undefined && loops.has(node.parent)) {
        problems.push(`${node.id} (loop) is inside loop ${node.parent}`);
      }
    }
    if (node.parent !== undefined && !loops.has(node.parent)) {
      problems.push(`${node.id} (${node.type}) has parent ${node.parent}, which is not a loop`);
    }
    return problems;
  });
}

export class StructureError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`cannot run this build: ${problems.join("; ")}`);
    this.name = "StructureError";
    this.problems = problems;
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

const lastMessage = (event: TurnEndEvent) => {
  const message = event.payload["last_assistant_message"];
  return typeof message === "string" ? message : undefined;
};

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
    const problems = structureProblems(manifest.nodes);
    if (problems.length > 0) throw new StructureError(problems);
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
    const context: RunContext = { hash: manifest.hash, nodes, states, ensureStarted };
    for (const node of nodes.filter((node) => node.parent === undefined)) {
      const { failure } = await this.runStep(node, context);
      if (failure !== undefined) {
        states[failure.nodeId] = move(states[failure.nodeId] ?? "waiting", "failed");
        this.emit(`${failure.nodeId} failed: ${failure.reason}`);
        return {
          outcome: "failed",
          failedNode: failure.nodeId,
          states,
          decisions: this.decisions,
        };
      }
    }
    return { outcome: "done", states, decisions: this.decisions };
  }

  private async runStep(
    node: ManifestNode,
    context: RunContext,
    condition?: string,
  ): Promise<StepResult> {
    const { hash, states, ensureStarted } = context;
    let failure: string | undefined;
    let reply: string | undefined;
    let doneLine = "done";
    if (node.type === "loop") {
      const result = await this.runLoop(node, context);
      if (result.failure !== undefined) return result;
    } else if (node.type === "prompt" || node.type === "agent") {
      const turn =
        node.type === "prompt"
          ? await this.runPrompt(node, hash, states, ensureStarted, condition)
          : await this.runAgent(node, hash, states, ensureStarted, condition);
      if (turn.failure === undefined) reply = turn.reply;
      else failure = turn.failure;
    } else if (node.type === "script") {
      failure = await this.runScript(node, states);
    } else {
      const outcome = await this.runHuman(node, states);
      if (outcome.status === "failed") failure = outcome.reason;
      else doneLine = outcome.line;
    }
    if (failure !== undefined) return { failure: { nodeId: node.id, reason: failure } };
    this.emit(`${node.id} ${doneLine}`);
    return { reply };
  }

  private async runLoop(loop: ManifestNode, context: RunContext): Promise<StepResult> {
    const { states } = context;
    const { condition, cap, onCap } = loop.settings as LoopSettings;
    const body = context.nodes.filter((node) => node.parent === loop.id);
    const verdictTurn = body.findLast((node) => node.type === "prompt" || node.type === "agent");
    const fail = (reason: string): StepResult => ({ failure: { nodeId: loop.id, reason } });
    states[loop.id] = move("waiting", "running");
    for (let round = 1; ;) {
      this.emit(`${loop.id} round ${round}`);
      let reply: string | undefined;
      for (const node of body) {
        if (round > 1) states[node.id] = move(states[node.id] ?? "waiting", "waiting");
        const isVerdictTurn = node === verdictTurn;
        const result = await this.runStep(node, context, isVerdictTurn ? condition : undefined);
        if (result.failure !== undefined) {
          states[loop.id] = move("running", "failed");
          return result;
        }
        if (isVerdictTurn) reply = result.reply;
      }
      const verdict = parseVerdict(reply);
      let step: LoopStep;
      if (verdict.kind === "verdict") {
        step = nextStep(round, cap, verdict.done);
      } else {
        const answer = await this.askLoop(
          loop,
          states,
          malformedRequest(loop.id, round, verdict.reason),
          (r) => malformedAnswer(loop.id, round, r),
        );
        if (answer.choice === "fail") return fail(answer.reason);
        if (answer.choice === "again") states[loop.id] = move("needs-you", "running");
        step = answer.choice === "done" ? { kind: "exit" } : nextStep(round, cap, false);
      }
      if (step.kind === "round") {
        round = step.round;
        continue;
      }
      if (step.kind === "cap") {
        if (onCap === "fail") return fail(`cap reached after ${cap} rounds`);
        const answer = await this.askLoop(loop, states, capRequest(loop.id, cap), (r) =>
          capAnswer(loop.id, cap, r),
        );
        if (answer.choice === "fail") return fail(answer.reason);
      }
      states[loop.id] = move(states[loop.id] ?? "running", "done");
      return {};
    }
  }

  private async askLoop(
    loop: ManifestNode,
    states: Record<string, NodeState>,
    request: WaitRequest,
    toAnswer: (reply: WaitReply) => LoopAnswer,
  ): Promise<LoopAnswer> {
    states[loop.id] = move("running", "needs-you");
    let answer: LoopAnswer;
    try {
      answer = toAnswer(await this.deps.waiter.wait(request));
    } catch (error) {
      return { choice: "fail", reason: messageOf(error) };
    }
    if (answer.decision?.decision === "answered") {
      this.decisions.push(answer.decision);
      this.emit(`${loop.id} answered: ${answer.decision.answer}`);
    }
    return answer;
  }

  private async runPrompt(
    node: ManifestNode,
    hash: string,
    states: Record<string, NodeState>,
    ensureStarted: () => Promise<void>,
    condition?: string,
  ): Promise<TurnResult> {
    states[node.id] = move("waiting", "sent");
    this.emit(`${node.id} started`);
    let end: TurnEndEvent;
    try {
      await ensureStarted();
      const turnEnd = waitForTurnEnd(
        this.deps.events,
        this.deps.sessionId,
        this.deps.turnTimeoutMs ?? defaultTurnTimeoutMs,
      );
      turnEnd.catch(() => undefined);
      const command = withPromptContext(`/${hash}:${node.id}`, this.takeAnswers());
      await this.deps.prompts.sendPrompt(
        condition === undefined ? command : `${command} ${verdictRequest(condition)}`,
      );
      end = await turnEnd;
    } catch (error) {
      return { failure: messageOf(error) };
    }
    states[node.id] = move("sent", "done");
    return { reply: condition === undefined ? undefined : lastMessage(end) };
  }

  private async runAgent(
    node: ManifestNode,
    hash: string,
    states: Record<string, NodeState>,
    ensureStarted: () => Promise<void>,
    condition?: string,
  ): Promise<TurnResult> {
    states[node.id] = move("waiting", "sent");
    this.emit(`${node.id} started`);
    let subagents: SubagentStops | undefined;
    let end: TurnEndEvent;
    try {
      await ensureStarted();
      subagents = recordSubagentStopsUntilStop(this.deps.events, this.deps.sessionId);
      const turnEnd = waitForTurnEnd(
        this.deps.events,
        this.deps.sessionId,
        this.deps.turnTimeoutMs ?? defaultTurnTimeoutMs,
      );
      turnEnd.catch(() => undefined);
      const turnText =
        condition === undefined
          ? agentTurnText(hash, node.id)
          : agentVerdictTurnText(hash, node.id, condition);
      await this.deps.prompts.sendPrompt(withAgentContext(turnText, this.takeAnswers()));
      end = await turnEnd;
    } catch (error) {
      return { failure: messageOf(error) };
    } finally {
      subagents?.unsubscribe();
    }
    if (agentOutcome(subagents.seen, hash, node.id) === "failed") {
      return { failure: `no SubagentStop for ${agentType(hash, node.id)}` };
    }
    states[node.id] = move("sent", "done");
    return { reply: condition === undefined ? undefined : lastMessage(end) };
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
