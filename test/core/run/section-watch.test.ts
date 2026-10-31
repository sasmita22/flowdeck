import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SectionWatch } from "../../../src/core/run/section-watch.js";
import type { TurnEndEvent, TurnEvents } from "../../../src/core/run/turns.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";

const ours = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const armedAt = 1000;
const a1 = "h:a1";
const a2 = "h:a2";
const a3 = "h:a3";
const branchTypes = [a1, a2, a3];
const timeoutMs = 5000;
const quietMs = 100;
const longTimeoutMs = 60_000;

type Outcome<T> = { status: "pending" | "resolved" | "rejected"; value?: T; error?: unknown };

function track<T>(promise: Promise<T>): Outcome<T> {
  const outcome: Outcome<T> = { status: "pending" };
  promise.then(
    (value) => Object.assign(outcome, { status: "resolved", value }),
    (error: unknown) => Object.assign(outcome, { status: "rejected", error }),
  );
  return outcome;
}

const hookEvent = (
  kind: HookEventKind,
  at: number,
  payload: Record<string, unknown> = {},
  sessionId = ours,
): HookEvent => ({
  kind,
  sessionId,
  payload: { hook_event_name: kind, session_id: sessionId, flowdeck_hook_at: at, ...payload },
});

const agentCall = (type: string, at: number, extra: Record<string, unknown> = {}) =>
  hookEvent("PreToolUse", at, {
    tool_name: "Agent",
    tool_input: { subagent_type: type, description: "Run", prompt: "Go" },
    ...extra,
  });

const subagentStop = (type: string, at: number, message = `${type} finished`) =>
  hookEvent("SubagentStop", at, { agent_type: type, last_assistant_message: message });

const stop = (at: number, message = `stop at ${at}`) =>
  hookEvent("Stop", at, { last_assistant_message: message });

describe("SectionWatch", () => {
  let source: FakeEventSource;
  let unsubscribes: Mock<() => void>[];
  let events: TurnEvents & { subscribe: Mock<TurnEvents["subscribe"]> };
  let onStopped: Mock<(type: string, message: unknown) => void>;
  let watch: SectionWatch;

  const publish = async (...published: HookEvent[]) => {
    for (const event of published) source.publish(event);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    source = new FakeEventSource();
    unsubscribes = [];
    events = {
      subscribe: vi.fn<TurnEvents["subscribe"]>((kind, sessionId, handler) => {
        const unsubscribe = vi.fn(source.subscribe(kind, sessionId, handler));
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      }),
    };
    onStopped = vi.fn();
    watch = new SectionWatch({ events, sessionId: ours, armedAt, branchTypes, onStopped });
  });

  afterEach(() => {
    watch.close();
    vi.useRealTimers();
  });

  describe("launched", () => {
    it("records each branch type the main session launches with the Agent tool", async () => {
      await publish(agentCall(a2, 1100), agentCall(a1, 1101));

      expect(new Set(watch.launched)).toEqual(new Set([a2, a1]));
    });

    it.each([
      { name: "a non-branch type", event: agentCall("h:elsewhere", 1100) },
      { name: "a subagent's own Agent call", event: agentCall(a1, 1100, { agent_id: "agent-1" }) },
      { name: "a call stamped before the arm time", event: agentCall(a1, armedAt - 1) },
      {
        name: "another tool",
        event: hookEvent("PreToolUse", 1100, { tool_name: "Bash", tool_input: { command: "ls" } }),
      },
      {
        name: "another session's call",
        event: hookEvent("PreToolUse", 1100, agentCall(a1, 1100).payload, other),
      },
    ])("ignores $name", async ({ event }) => {
      await publish(event);

      expect([...watch.launched]).toEqual([]);
    });
  });

  describe("onStopped", () => {
    it("reports a branch's first SubagentStop with its message", async () => {
      await publish(subagentStop(a1, 1200, "a1 done"));

      expect(onStopped.mock.calls).toEqual([[a1, "a1 done"]]);
    });

    it("reports each branch once, ignoring a duplicate", async () => {
      await publish(subagentStop(a1, 1200, "first"), subagentStop(a1, 1300, "again"));

      expect(onStopped.mock.calls).toEqual([[a1, "first"]]);
    });

    it.each([
      { name: "a non-branch type", event: subagentStop("h:elsewhere", 1200) },
      { name: "a SubagentStop stamped before the arm time", event: subagentStop(a1, armedAt - 1) },
      {
        name: "another session's SubagentStop",
        event: hookEvent("SubagentStop", 1200, subagentStop(a1, 1200).payload, other),
      },
    ])("ignores $name", async ({ event }) => {
      await publish(event);

      expect(onStopped).not.toHaveBeenCalled();
    });
  });

  describe("untilStopped", () => {
    const both = (stopped: ReadonlySet<string>) => stopped.has(a1) && stopped.has(a2);

    it("resolves once the predicate holds over the stopped branches", async () => {
      const outcome = track(watch.untilStopped(both, timeoutMs, () => false));

      await publish(subagentStop(a1, 1200));
      expect(outcome.status).toBe("pending");

      await publish(subagentStop(a2, 1300));
      expect(outcome.status).toBe("resolved");
    });

    it("resolves at once when the stops arrived before the call", async () => {
      await publish(subagentStop(a1, 1200), subagentStop(a2, 1300));

      const outcome = track(watch.untilStopped(both, timeoutMs, () => false));
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.status).toBe("resolved");
    });

    it("does not count ignored SubagentStops", async () => {
      const outcome = track(
        watch.untilStopped(
          (stopped) => stopped.size > 0,
          timeoutMs,
          () => false,
        ),
      );

      await publish(subagentStop("h:elsewhere", 1200), subagentStop(a1, armedAt - 1));

      expect(outcome.status).toBe("pending");
    });

    it("rejects naming the timeout when the predicate never holds", async () => {
      const outcome = track(watch.untilStopped(both, timeoutMs, () => false));
      await publish(subagentStop(a1, 1200));

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(outcome.status).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.status).toBe("rejected");
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain("no SubagentStop");
      expect((outcome.error as Error).message).toContain(`within ${timeoutMs} ms`);
    });

    it("keeps waiting past the timeout while held", async () => {
      let held = true;
      const outcome = track(watch.untilStopped(both, timeoutMs, () => held));

      await vi.advanceTimersByTimeAsync(timeoutMs * 3);
      expect(outcome.status).toBe("pending");

      held = false;
      await publish(subagentStop(a1, 1200), subagentStop(a2, 1300));
      expect(outcome.status).toBe("resolved");
    });

    it("rejects at the next timeout once it stops being held", async () => {
      let held = true;
      const outcome = track(watch.untilStopped(both, timeoutMs, () => held));

      await vi.advanceTimersByTimeAsync(timeoutMs * 2 + timeoutMs / 2);
      held = false;
      await vi.advanceTimersByTimeAsync(timeoutMs / 2 - 1);
      expect(outcome.status).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.status).toBe("rejected");
    });
  });

  describe("settled", () => {
    it("resolves with the Stop after the last SubagentStop once the session is quiet", async () => {
      await publish(subagentStop(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));
      const settle = stop(1300);

      await publish(settle);
      await vi.advanceTimersByTimeAsync(quietMs - 1);
      expect(outcome.status).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("does not settle on a Stop stamped before the last SubagentStop", async () => {
      await publish(stop(1100), subagentStop(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));

      await vi.advanceTimersByTimeAsync(quietMs * 3);
      expect(outcome.status).toBe("pending");

      const settle = stop(1300);
      await publish(settle);
      await vi.advanceTimersByTimeAsync(quietMs);
      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("restarts the quiet window on a further Stop and resolves with the later one", async () => {
      await publish(subagentStop(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));

      await publish(stop(1300, "first"));
      await vi.advanceTimersByTimeAsync(quietMs * 0.6);
      const later = stop(1400, "later");
      await publish(later);
      await vi.advanceTimersByTimeAsync(quietMs * 0.6);
      expect(outcome.status).toBe("pending");

      await vi.advanceTimersByTimeAsync(quietMs * 0.4);
      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(later.payload);
    });

    it("needs a later Stop when another branch stops during the quiet window", async () => {
      await publish(subagentStop(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));

      await publish(stop(1300));
      await vi.advanceTimersByTimeAsync(quietMs / 2);
      await publish(subagentStop(a2, 1400));
      await vi.advanceTimersByTimeAsync(quietMs * 3);
      expect(outcome.status).toBe("pending");

      const settle = stop(1500);
      await publish(settle);
      await vi.advanceTimersByTimeAsync(quietMs);
      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("keeps the window when a duplicate SubagentStop arrives during it", async () => {
      await publish(subagentStop(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));
      const settle = stop(1300);

      await publish(settle);
      await vi.advanceTimersByTimeAsync(quietMs / 2);
      await publish(subagentStop(a1, 1400));
      await vi.advanceTimersByTimeAsync(quietMs / 2);

      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("counts a Stop that arrived before the call", async () => {
      const settle = stop(1300);
      await publish(subagentStop(a1, 1200), settle);

      const outcome = track(watch.settled(quietMs, longTimeoutMs));
      await vi.advanceTimersByTimeAsync(quietMs);

      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("ignores a Stop stamped before the arm time", async () => {
      const outcome = track(watch.settled(quietMs, longTimeoutMs));

      await publish(stop(armedAt - 1));
      await vi.advanceTimersByTimeAsync(quietMs * 3);

      expect(outcome.status).toBe("pending");
    });
  });

  describe("close", () => {
    it("releases its three subscriptions and every timer", async () => {
      track(
        watch.untilStopped(
          () => false,
          timeoutMs,
          () => false,
        ),
      );
      await publish(subagentStop(a1, 1200), stop(1300));
      const settling: Outcome<TurnEndEvent> = track(watch.settled(quietMs, longTimeoutMs));
      expect(settling.status).toBe("pending");

      watch.close();

      expect(
        new Set(events.subscribe.mock.calls.map(([kind, sessionId]) => `${kind}:${sessionId}`)),
      ).toEqual(new Set([`Stop:${ours}`, `SubagentStop:${ours}`, `PreToolUse:${ours}`]));
      expect(unsubscribes).toHaveLength(3);
      for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
