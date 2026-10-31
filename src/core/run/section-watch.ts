import { stampedBefore, type TurnEndEvent, type TurnEvents } from "./turns.js";

export type SectionWatchDeps = {
  events: TurnEvents;
  sessionId: string;
  armedAt: number;
  branchTypes: readonly string[];
  onStopped: (type: string, message: unknown) => void;
};

type Timer = ReturnType<typeof setTimeout>;

const stampOf = (event: TurnEndEvent) => {
  const at = event.payload["flowdeck_hook_at"];
  return typeof at === "number" ? at : Number.POSITIVE_INFINITY;
};

export class SectionWatch {
  readonly launched = new Set<string>();
  private readonly stopped = new Set<string>();
  private lastStoppedAt = Number.NEGATIVE_INFINITY;
  private latestStop: TurnEndEvent | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Set<Timer>();
  private readonly unsubscribes: (() => void)[];

  constructor(private readonly deps: SectionWatchDeps) {
    const { events, sessionId } = deps;
    this.unsubscribes = [
      events.subscribe("PreToolUse", sessionId, (event) => this.onToolUse(event)),
      events.subscribe("SubagentStop", sessionId, (event) => this.onSubagentStop(event)),
      events.subscribe("Stop", sessionId, (event) => this.onStop(event)),
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
        if (!predicate(this.stopped)) return;
        finish();
        resolve();
      };
      const arm = () => {
        timer = this.schedule(() => {
          if (held()) return arm();
          finish();
          reject(
            new Error(`no SubagentStop for session ${this.deps.sessionId} within ${timeoutMs} ms`),
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

  private onToolUse(event: TurnEndEvent) {
    const { payload } = event;
    if (stampedBefore(event, this.deps.armedAt)) return;
    if (payload["tool_name"] !== "Agent" || payload["agent_id"] !== undefined) return;
    const input = payload["tool_input"] as Record<string, unknown> | undefined;
    const type = input?.["subagent_type"];
    if (typeof type === "string" && this.deps.branchTypes.includes(type)) this.launched.add(type);
  }

  private onSubagentStop(event: TurnEndEvent) {
    const type = event.payload["agent_type"];
    if (stampedBefore(event, this.deps.armedAt)) return;
    if (typeof type !== "string" || !this.deps.branchTypes.includes(type)) return;
    if (this.stopped.has(type)) return;
    this.stopped.add(type);
    this.lastStoppedAt = Math.max(this.lastStoppedAt, stampOf(event));
    this.deps.onStopped(type, event.payload["last_assistant_message"]);
    this.notify();
  }

  private onStop(event: TurnEndEvent) {
    if (stampedBefore(event, this.deps.armedAt)) return;
    this.latestStop = event;
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
