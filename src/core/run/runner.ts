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
import type { ResumeAction, ResumeActions } from "./resume.js";
import { decisionsOf, loopRound, nodeStatus, type RunEvent } from "./run-events.js";
import type { NodeState } from "./state.js";
import type { EventEntry, Store, StoredEvent } from "./store.js";
import { stampedBefore, waitForTurnEnd, type TurnEndEvent, type TurnEvents } from "./turns.js";
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
  store: Store;
  runId: string;
  now?: () => number;
};

export type RunOptions = { actions?: ResumeActions };

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

const reasonIn = (nodeId: string, message: string) => message.replace(`${nodeId} failed: `, "");

function replyFor(decision: HumanDecision): WaitReply {
  switch (decision.decision) {
    case "answered":
      return { decision: "answer", answer: decision.answer };
    case "rejected":
      return { decision: "reject", reason: decision.reason };
    case "stopped":
      return { decision: "stop", reason: decision.reason };
    case "continued":
      return { decision: "continue" };
    default:
      return { decision: "approve" };
  }
}

const decisionEvent = (decision: HumanDecision): RunEvent => ({
  kind: decision.decision === "answered" ? "answered" : "decided",
  payload: decision,
});

const exitReason = (code: number | null) =>
  code === null ? "killed by a signal" : `exit code ${code}`;

type SubagentStops = { seen: string[]; unsubscribe: () => void };

function recordSubagentStopsUntilStop(
  events: TurnEvents,
  sessionId: string,
  armedAt: number | undefined,
): SubagentStops {
  const seen: string[] = [];
  const stopRecording = events.subscribe("SubagentStop", sessionId, (event) => {
    const type = event.payload["agent_type"];
    if (typeof type === "string") seen.push(type);
  });
  const stopWatching = events.subscribe("Stop", sessionId, (event) => {
    if (!stampedBefore(event, armedAt)) stopRecording();
  });
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
  private actions = new Map<string, ResumeAction>();
  private pendingAnswers: string[] = [];
  private answersSentWith = new Map<string, string[]>();

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.emit = deps.onChange ?? (() => undefined);
  }

  async run(manifest: RunnableManifest, options: RunOptions = {}): Promise<RunResult> {
    const problems = structureProblems(manifest.nodes);
    if (problems.length > 0) throw new StructureError(problems);
    const nodes = manifest.nodes.filter((node) => runnable.has(node.type));
    this.actions = new Map(Object.entries(options.actions ?? {}));
    this.replayAnswers(nodes);
    let started = false;
    const ensureStarted = async () => {
      if (started) return;
      await this.deps.session.ensureStarted();
      started = true;
    };
    const context: RunContext = { hash: manifest.hash, nodes, ensureStarted };
    for (const node of nodes.filter((node) => node.parent === undefined)) {
      const { failure } = await this.runStep(node, context);
      if (failure !== undefined) {
        const line = `${failure.nodeId} failed: ${failure.reason}`;
        if (this.status(failure.nodeId) !== "failed") {
          this.record(failure.nodeId, { kind: "failed", payload: { message: line } });
        }
        this.emit(line);
        return { outcome: "failed", failedNode: failure.nodeId, ...this.projection(nodes) };
      }
    }
    return { outcome: "done", ...this.projection(nodes) };
  }

  private projection(nodes: readonly ManifestNode[]): Pick<RunResult, "states" | "decisions"> {
    const events = this.allEvents();
    return {
      states: Object.fromEntries(
        nodes.map((node) => [
          node.id,
          nodeStatus(events.filter((event) => event.nodeId === node.id)),
        ]),
      ),
      decisions: decisionsOf(events),
    };
  }

  private replayAnswers(nodes: readonly ManifestNode[]): void {
    const asks = new Set(nodes.filter((node) => node.type === "ask").map((node) => node.id));
    const answered = new Map<string, string>();
    let pending: string[] = [];
    this.answersSentWith = new Map();
    for (const event of this.allEvents()) {
      if (event.kind === "answered" && asks.has(event.nodeId)) {
        if (event.payload.decision === "answered") answered.set(event.nodeId, event.payload.answer);
      }
      const answer = answered.get(event.nodeId);
      if (event.kind === "done" && answer !== undefined) {
        pending.push(answer);
        answered.delete(event.nodeId);
      }
      if (event.kind === "sent") {
        this.answersSentWith.set(event.nodeId, pending);
        pending = [];
      }
    }
    this.pendingAnswers = pending;
  }

  private allEvents(): StoredEvent[] {
    return this.deps.store.events(this.deps.runId);
  }

  private eventsOf(nodeId: string): StoredEvent[] {
    return this.allEvents().filter((event) => event.nodeId === nodeId);
  }

  private status(nodeId: string): NodeState {
    return nodeStatus(this.eventsOf(nodeId));
  }

  private record(nodeId: string, event: RunEvent): void {
    nodeStatus([...this.eventsOf(nodeId), event]);
    this.deps.store.append(this.deps.runId, nodeId, event);
  }

  private recordAll(entries: readonly EventEntry[]): void {
    const after = [
      ...this.allEvents(),
      ...entries.map(({ nodeId, event }) => ({ ...event, nodeId })),
    ];
    for (const { nodeId } of entries) nodeStatus(after.filter((event) => event.nodeId === nodeId));
    this.deps.store.appendAll(this.deps.runId, entries);
  }

  private takeAction(nodeId: string): ResumeAction | undefined {
    const action = this.actions.get(nodeId);
    this.actions.delete(nodeId);
    return action;
  }

  private settled(node: ManifestNode, condition?: string): StepResult | undefined {
    const events = this.eventsOf(node.id);
    const status = nodeStatus(events);
    if (status === "done" || status === "skipped") {
      const done = events.findLast((event) => event.kind === "done");
      const stopMessage = done?.kind === "done" ? done.payload?.stopMessage : undefined;
      return { reply: condition === undefined ? undefined : stopMessage };
    }
    if (status === "failed") {
      const failed = events.findLast((event) => event.kind === "failed");
      const message = failed?.kind === "failed" ? failed.payload.message : "";
      return { failure: { nodeId: node.id, reason: reasonIn(node.id, message) } };
    }
    return undefined;
  }

  private async runStep(
    node: ManifestNode,
    context: RunContext,
    condition?: string,
  ): Promise<StepResult> {
    const settled = this.settled(node, condition);
    if (settled !== undefined) return settled;
    const { hash, ensureStarted } = context;
    let failure: string | undefined;
    let reply: string | undefined;
    let doneLine = "done";
    if (node.type === "loop") {
      const result = await this.runLoop(node, context);
      if (result.failure !== undefined) return result;
    } else if (node.type === "prompt" || node.type === "agent") {
      const turn =
        node.type === "prompt"
          ? await this.runPrompt(node, hash, ensureStarted, condition)
          : await this.runAgent(node, hash, ensureStarted, condition);
      if (turn.failure === undefined) reply = turn.reply;
      else failure = turn.failure;
    } else if (node.type === "script") {
      failure = await this.runScript(node);
    } else {
      const outcome = await this.runHuman(node);
      if (outcome.status === "failed") failure = outcome.reason;
      else doneLine = outcome.line;
    }
    if (failure !== undefined) return { failure: { nodeId: node.id, reason: failure } };
    this.emit(`${node.id} ${doneLine}`);
    return { reply };
  }

  private async runLoop(loop: ManifestNode, context: RunContext): Promise<StepResult> {
    const { condition, cap, onCap } = loop.settings as LoopSettings;
    const body = context.nodes.filter((node) => node.parent === loop.id);
    const verdictTurn = body.findLast((node) => node.type === "prompt" || node.type === "agent");
    const fail = (reason: string): StepResult => ({ failure: { nodeId: loop.id, reason } });
    let round = loopRound(this.eventsOf(loop.id));
    let resumingRound = round > 0;
    if (this.status(loop.id) === "waiting") this.record(loop.id, { kind: "running" });
    if (!resumingRound) round = 1;
    let reopen: EventEntry[] = [];
    for (;;) {
      if (resumingRound) resumingRound = false;
      else this.startRound(loop.id, round, body, reopen);
      reopen = [];
      let reply: string | undefined;
      for (const node of body) {
        const isVerdictTurn = node === verdictTurn;
        const result = await this.runStep(node, context, isVerdictTurn ? condition : undefined);
        if (result.failure !== undefined) {
          const message = `${result.failure.nodeId} failed: ${result.failure.reason}`;
          this.record(loop.id, { kind: "failed", payload: { message } });
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
          malformedRequest(loop.id, round, verdict.reason),
          (r) => malformedAnswer(loop.id, round, r),
        );
        if (answer.choice === "fail") return fail(answer.reason);
        if (answer.choice === "again") reopen = [{ nodeId: loop.id, event: { kind: "running" } }];
        step = answer.choice === "done" ? { kind: "exit" } : nextStep(round, cap, false);
      }
      if (step.kind === "round") {
        round = step.round;
        continue;
      }
      if (reopen.length > 0) this.recordAll(reopen);
      if (step.kind === "cap") {
        if (onCap === "fail") return fail(`cap reached after ${cap} rounds`);
        const answer = await this.askLoop(loop, capRequest(loop.id, cap), (r) =>
          capAnswer(loop.id, cap, r),
        );
        if (answer.choice === "fail") return fail(answer.reason);
      }
      this.record(loop.id, { kind: "done" });
      return {};
    }
  }

  private startRound(
    loopId: string,
    round: number,
    body: readonly ManifestNode[],
    reopen: readonly EventEntry[],
  ): void {
    const resets =
      round > 1
        ? body.map((node): EventEntry => ({ nodeId: node.id, event: { kind: "reset" } }))
        : [];
    this.recordAll([
      ...reopen,
      { nodeId: loopId, event: { kind: "round", payload: { round } } },
      ...resets,
    ]);
    this.emit(`${loopId} round ${round}`);
  }

  private async askLoop(
    loop: ManifestNode,
    request: WaitRequest,
    toAnswer: (reply: WaitReply) => LoopAnswer,
  ): Promise<LoopAnswer> {
    const action = this.takeAction(loop.id);
    if (this.status(loop.id) !== "needs-you") this.record(loop.id, { kind: "needs-you" });
    let answer: LoopAnswer;
    try {
      answer = toAnswer(
        action?.kind === "reuse" ? replyFor(action.decision) : await this.deps.waiter.wait(request),
      );
    } catch (error) {
      return { choice: "fail", reason: messageOf(error) };
    }
    if (answer.decision?.decision === "answered") {
      if (action?.kind !== "reuse") {
        this.record(loop.id, { kind: "answered", payload: answer.decision });
      }
      this.emit(`${loop.id} answered: ${answer.decision.answer}`);
    }
    return answer;
  }

  private armTurnEnd(armedAt?: number): Promise<TurnEndEvent> {
    const turnEnd = waitForTurnEnd(
      this.deps.events,
      this.deps.sessionId,
      this.deps.turnTimeoutMs ?? defaultTurnTimeoutMs,
      armedAt,
    );
    turnEnd.catch(() => undefined);
    return turnEnd;
  }

  private finishTurn(nodeId: string, stopMessage: string | undefined, condition?: string) {
    this.record(
      nodeId,
      stopMessage === undefined ? { kind: "done" } : { kind: "done", payload: { stopMessage } },
    );
    return { reply: condition === undefined ? undefined : stopMessage };
  }

  private answersFor(nodeId: string, action: ResumeAction | undefined): string[] {
    if (action?.kind === "send") return this.answersSentWith.get(nodeId) ?? [];
    this.record(nodeId, { kind: "sent" });
    return this.takeAnswers();
  }

  private async runPrompt(
    node: ManifestNode,
    hash: string,
    ensureStarted: () => Promise<void>,
    condition?: string,
  ): Promise<TurnResult> {
    const action = this.takeAction(node.id);
    if (action?.kind === "complete") return this.finishTurn(node.id, action.stopMessage, condition);
    let end: TurnEndEvent;
    try {
      if (action?.kind === "wait") {
        end = await this.armTurnEnd();
      } else {
        const answers = this.answersFor(node.id, action);
        this.emit(`${node.id} started`);
        await ensureStarted();
        const turnEnd = this.armTurnEnd(this.deps.now?.());
        const command = withPromptContext(`/${hash}:${node.id}`, answers);
        await this.deps.prompts.sendPrompt(
          condition === undefined ? command : `${command} ${verdictRequest(condition)}`,
        );
        end = await turnEnd;
      }
    } catch (error) {
      return { failure: messageOf(error) };
    }
    return this.finishTurn(node.id, lastMessage(end), condition);
  }

  private async runAgent(
    node: ManifestNode,
    hash: string,
    ensureStarted: () => Promise<void>,
    condition?: string,
  ): Promise<TurnResult> {
    const action = this.takeAction(node.id);
    if (action?.kind === "complete") return this.finishTurn(node.id, action.stopMessage, condition);
    if (action?.kind === "wait") {
      try {
        return this.finishTurn(node.id, lastMessage(await this.armTurnEnd()), condition);
      } catch (error) {
        return { failure: messageOf(error) };
      }
    }
    const answers = this.answersFor(node.id, action);
    this.emit(`${node.id} started`);
    let subagents: SubagentStops | undefined;
    let end: TurnEndEvent;
    try {
      await ensureStarted();
      const armedAt = this.deps.now?.();
      subagents = recordSubagentStopsUntilStop(this.deps.events, this.deps.sessionId, armedAt);
      const turnEnd = this.armTurnEnd(armedAt);
      const turnText =
        condition === undefined
          ? agentTurnText(hash, node.id)
          : agentVerdictTurnText(hash, node.id, condition);
      await this.deps.prompts.sendPrompt(withAgentContext(turnText, answers));
      end = await turnEnd;
    } catch (error) {
      return { failure: messageOf(error) };
    } finally {
      subagents?.unsubscribe();
    }
    if (agentOutcome(subagents.seen, hash, node.id) === "failed") {
      return { failure: `no SubagentStop for ${agentType(hash, node.id)}` };
    }
    return this.finishTurn(node.id, lastMessage(end), condition);
  }

  private takeAnswers(): string[] {
    const answers = this.pendingAnswers;
    this.pendingAnswers = [];
    return answers;
  }

  private runHuman(node: ManifestNode): Promise<HumanOutcome> {
    if (node.type === "gate") return this.runGate(node);
    if (node.type === "ask") return this.runAsk(node);
    return this.runHardstop(node);
  }

  private recordDecision(nodeId: string, decision: HumanDecision): void {
    this.record(nodeId, decisionEvent(decision));
  }

  private async runGate(node: ManifestNode): Promise<HumanOutcome> {
    const settings = node.settings as GateSettings;
    if (gateSkips(settings, this.deps.auto ?? false)) {
      const decision: HumanDecision = { nodeId: node.id, decision: "skipped" };
      this.recordAll([
        { nodeId: node.id, event: decisionEvent(decision) },
        { nodeId: node.id, event: { kind: "skipped" } },
      ]);
      return { status: "done", line: "skipped", decision };
    }
    return this.waitFor(node, gateRequest(node.id, settings), (reply) =>
      gateOutcome(node.id, reply),
    );
  }

  private async runAsk(node: ManifestNode): Promise<HumanOutcome> {
    const outcome = await this.waitFor(
      node,
      askRequest(node.id, node.settings as AskSettings),
      (reply) => askOutcome(node.id, reply),
    );
    if (outcome.status === "done" && outcome.decision.decision === "answered") {
      this.pendingAnswers.push(outcome.decision.answer);
    }
    return outcome;
  }

  private runHardstop(node: ManifestNode): Promise<HumanOutcome> {
    return this.waitFor(
      node,
      hardstopRequest(node.id, node.settings as HardstopSettings),
      (reply) => hardstopOutcome(node.id, reply),
    );
  }

  private async waitFor(
    node: ManifestNode,
    request: WaitRequest,
    toOutcome: (reply: WaitReply) => HumanOutcome,
  ): Promise<HumanOutcome> {
    const action = this.takeAction(node.id);
    if (this.status(node.id) !== "needs-you") this.record(node.id, { kind: "needs-you" });
    let outcome: HumanOutcome;
    try {
      outcome = toOutcome(
        action?.kind === "reuse" ? replyFor(action.decision) : await this.deps.waiter.wait(request),
      );
    } catch (error) {
      return { status: "failed", reason: messageOf(error) };
    }
    if (outcome.decision !== undefined && action?.kind !== "reuse") {
      this.recordDecision(node.id, outcome.decision);
    }
    if (outcome.status === "done") this.record(node.id, { kind: "done" });
    return outcome;
  }

  private async runScript(node: ManifestNode): Promise<string | undefined> {
    const action = this.takeAction(node.id);
    if (action?.kind === "fail") return reasonIn(node.id, action.message);
    const { command, args } = node.settings as ScriptSettings;
    this.record(node.id, { kind: "running" });
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
        this.record(node.id, { kind: "done" });
        return undefined;
      }
      this.recordAll([
        { nodeId: node.id, event: { kind: "retry" } },
        { nodeId: node.id, event: { kind: "running" } },
      ]);
      this.emit(`${node.id} retry`);
    }
  }
}
