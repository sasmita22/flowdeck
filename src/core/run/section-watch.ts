import { agentCallOf } from "./agent-calls.js";
import { stampedBefore, turnFailure, type TurnEndEvent, type TurnEvents } from "./turns.js";

export type SectionWatchDeps = {
  events: TurnEvents;
  sessionId: string;
  armedAt: number;
  branchNodes: readonly string[];
  onStopped: (nodeId: string, message: unknown, toolUseId: string | undefined) => void;
};

type Timer = ReturnType<typeof setTimeout>;

const stampOf = (event: TurnEndEvent) => {
  const at = event.payload["flowdeck_hook_at"];
  return typeof at === "number" ? at : Number.POSITIVE_INFINITY;
};

const replyOf = (event: TurnEndEvent): string | undefined => {
  const response = event.payload["tool_response"] as { content?: unknown } | undefined;
  const content = Array.isArray(response?.content) ? (response.content as unknown[]) : [];
  const texts = content.flatMap((part) => {
    const text = (part as { text?: unknown } | null)?.text;
    return typeof text === "string" ? [text] : [];
  });
  return texts.length === 0 ? undefined : texts.join("\n");
};

export class SectionWatch {
  readonly launched = new Set<string>();
  private readonly stopped = new Set<string>();
  private lastStoppedAt = Number.NEGATIVE_INFINITY;
  private latestStop: TurnEndEvent | undefined;
  private failure: Error | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Set<Timer>();
  private readonly unsubscribes: (() => void)[];

  constructor(private readonly deps: SectionWatchDeps) {
    const { events, sessionId } = deps;
    this.unsubscribes = [
      events.subscribe("PreToolUse", sessionId, (event) => this.onToolUse(event)),
      events.subscribe("PostToolUse", sessionId, (event) => this.onAgentDone(event)),
      events.subscribe("Stop", sessionId, (event) => this.onStop(event)),
      events.subscribe("StopFailure", sessionId, (event) => this.onStopFailure(event)),
    ];
  }

  untilStopped(
    predicate: (stopped: ReadonlySet<string>) => boolean,
    timeoutMs: number,
    held: () => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: Timer | undefined;
      const finish = () => {
        this.listeners.delete(check);
        this.clear(timer);
      };
      const check = () => {
        if (predicate(this.stopped)) {
          finish();
          resolve();
        } else if (this.failure !== undefined) {
          finish();
          reject(this.failure);
        }
      };
      const arm = () => {
        timer = this.schedule(() => {
          if (held()) return arm();
          finish();
          reject(
            new Error(
              `no finished Agent call for session ${this.deps.sessionId} within ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      };
      this.listeners.add(check);
      arm();
      check();
    });
  }

  settled(quietMs: number, timeoutMs: number): Promise<TurnEndEvent> {
    return new Promise((resolve, reject) => {
      let quiet: Timer | undefined;
      let quietFor: TurnEndEvent | undefined;
      const finish = () => {
        this.listeners.delete(check);
        this.clear(quiet);
        this.clear(deadline);
      };
      const check = () => {
        if (this.failure !== undefined) {
          finish();
          reject(this.failure);
          return;
        }
        const stop = this.latestStop;
        const settling = stop !== undefined && stampOf(stop) >= this.lastStoppedAt;
        if (!settling) {
          this.clear(quiet);
          quiet = quietFor = undefined;
          return;
        }
        if (quietFor === stop) return;
        this.clear(quiet);
        quietFor = stop;
        quiet = this.schedule(() => {
          finish();
          resolve(stop);
        }, quietMs);
      };
      const deadline = this.schedule(() => {
        finish();
        reject(
          new Error(`no settling Stop for session ${this.deps.sessionId} within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  close(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  private branchOf(kind: "PreToolUse" | "PostToolUse", event: TurnEndEvent) {
    if (stampedBefore(event, this.deps.armedAt)) return undefined;
    if (event.payload["agent_id"] !== undefined) return undefined;
    const call = agentCallOf({ kind, payload: event.payload });
    const nodeId = call?.nodeId;
    return nodeId !== undefined && this.deps.branchNodes.includes(nodeId)
      ? { nodeId, toolUseId: call?.toolUseId }
      : undefined;
  }

  private onToolUse(event: TurnEndEvent) {
    const branch = this.branchOf("PreToolUse", event);
    if (branch !== undefined) this.launched.add(branch.nodeId);
  }

  private onAgentDone(event: TurnEndEvent) {
    const branch = this.branchOf("PostToolUse", event);
    if (branch === undefined || this.stopped.has(branch.nodeId)) return;
    this.stopped.add(branch.nodeId);
    this.lastStoppedAt = Math.max(this.lastStoppedAt, stampOf(event));
    this.deps.onStopped(branch.nodeId, replyOf(event), branch.toolUseId);
    this.notify();
  }

  private onStop(event: TurnEndEvent) {
    if (stampedBefore(event, this.deps.armedAt)) return;
    this.latestStop = event;
    this.notify();
  }

  private onStopFailure(event: TurnEndEvent) {
    if (stampedBefore(event, this.deps.armedAt)) return;
    this.failure = turnFailure(event);
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  private schedule(run: () => void, ms: number): Timer {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private clear(timer: Timer | undefined) {
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }
}
