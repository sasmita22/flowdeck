import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SectionWatch } from "../../../src/core/run/section-watch.js";
import type { TurnEndEvent, TurnEvents } from "../../../src/core/run/turns.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";

const ours = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const armedAt = 1000;
const a1 = "a1";
const a2 = "a2";
const a3 = "a3";
const branchNodes = [a1, a2, a3];
const piece = "h:review";
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

const agentInput = (nodeId: string) => ({
  subagent_type: piece,
  description: "Run",
  prompt: `NODE ${nodeId}\nGo`,
});

const agentCall = (nodeId: string, at: number, extra: Record<string, unknown> = {}) =>
  hookEvent("PreToolUse", at, {
    tool_name: "Agent",
    tool_input: agentInput(nodeId),
    tool_use_id: `toolu-${nodeId}`,
    ...extra,
  });

const agentDone = (nodeId: string, at: number, message = `${nodeId} finished`) =>
  hookEvent("PostToolUse", at, {
    tool_name: "Agent",
    tool_input: agentInput(nodeId),
    tool_use_id: `toolu-${nodeId}`,
    tool_response: {
      status: "completed",
      agentId: `agent-${nodeId}`,
      agentType: piece,
      content: [{ type: "text", text: message }],
    },
  });

const stop = (at: number, message = `stop at ${at}`) =>
  hookEvent("Stop", at, { last_assistant_message: message });

const notLoggedIn = "Not logged in · Please run /login";
const stopFailure = (at: number, sessionId = ours) =>
  hookEvent(
    "StopFailure",
    at,
    { error: "authentication_failed", last_assistant_message: notLoggedIn },
    sessionId,
  );

describe("SectionWatch", () => {
  let source: FakeEventSource;
  let unsubscribes: Mock<() => void>[];
  let events: TurnEvents & { subscribe: Mock<TurnEvents["subscribe"]> };
  let onStopped: Mock<(nodeId: string, message: unknown, toolUseId: string | undefined) => void>;
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
    watch = new SectionWatch({ events, sessionId: ours, armedAt, branchNodes, onStopped });
  });

  afterEach(() => {
    watch.close();
    vi.useRealTimers();
  });

  describe("launched", () => {
    it("records each branch node the main session launches with the Agent tool, by its marker", async () => {
      await publish(agentCall(a2, 1100), agentCall(a1, 1101));

      expect(new Set(watch.launched)).toEqual(new Set([a2, a1]));
    });

    it.each([
      { name: "a non-branch node", event: agentCall("elsewhere", 1100) },
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
    it("reports a branch's first finished Agent call with its message and call id", async () => {
      await publish(agentDone(a1, 1200, "a1 done"));

      expect(onStopped.mock.calls).toEqual([[a1, "a1 done", "toolu-a1"]]);
    });

    it("reports each branch once, ignoring a duplicate", async () => {
      await publish(agentDone(a1, 1200, "first"), agentDone(a1, 1300, "again"));

      expect(onStopped.mock.calls).toEqual([[a1, "first", "toolu-a1"]]);
    });

    it.each([
      { name: "a non-branch node", event: agentDone("elsewhere", 1200) },
      { name: "a finished call stamped before the arm time", event: agentDone(a1, armedAt - 1) },
      {
        name: "another session's finished call",
        event: hookEvent("PostToolUse", 1200, agentDone(a1, 1200).payload, other),
      },
      {
        name: "a SubagentStop with no agent type",
        event: hookEvent("SubagentStop", 1200, { agent_id: "a2acfd3c49ca63d33", agent_type: "" }),
      },
      {
        name: "a SubagentStop of the branches' own type",
        event: hookEvent("SubagentStop", 1200, { agent_id: "agent-a1", agent_type: piece }),
      },
    ])("ignores $name", async ({ event }) => {
      await publish(event);

      expect(onStopped).not.toHaveBeenCalled();
    });
  });

  describe("two branches on one piece", () => {
    it.each([
      { first: a2, second: a1 },
      { first: a1, second: a2 },
    ])("tracks and settles $first then $second separately", async ({ first, second }) => {
      const both = (stopped: ReadonlySet<string>) => stopped.has(a1) && stopped.has(a2);
      await publish(agentCall(a1, 1100), agentCall(a2, 1101));
      expect(new Set(watch.launched)).toEqual(new Set([a1, a2]));
      const outcome = track(watch.untilStopped(both, timeoutMs, () => false));

      await publish(agentDone(first, 1200, `${first} done`));
      expect(onStopped.mock.calls).toEqual([[first, `${first} done`, `toolu-${first}`]]);
      expect(outcome.status).toBe("pending");

      await publish(agentDone(second, 1300, `${second} done`));
      expect(onStopped.mock.calls).toEqual([
        [first, `${first} done`, `toolu-${first}`],
        [second, `${second} done`, `toolu-${second}`],
      ]);
      expect(outcome.status).toBe("resolved");
    });
  });

  describe("untilStopped", () => {
    const both = (stopped: ReadonlySet<string>) => stopped.has(a1) && stopped.has(a2);

    it("resolves once the predicate holds over the stopped branches", async () => {
      const outcome = track(watch.untilStopped(both, timeoutMs, () => false));

      await publish(agentDone(a1, 1200));
      expect(outcome.status).toBe("pending");

      await publish(agentDone(a2, 1300));
      expect(outcome.status).toBe("resolved");
    });

    it("resolves at once when the stops arrived before the call", async () => {
      await publish(agentDone(a1, 1200), agentDone(a2, 1300));

      const outcome = track(watch.untilStopped(both, timeoutMs, () => false));
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.status).toBe("resolved");
    });

    it("does not count ignored calls", async () => {
      const outcome = track(
        watch.untilStopped(
          (stopped) => stopped.size > 0,
          timeoutMs,
          () => false,
        ),
      );

      await publish(agentDone("elsewhere", 1200), agentDone(a1, armedAt - 1));

      expect(outcome.status).toBe("pending");
    });

    it("rejects naming the timeout when the predicate never holds", async () => {
      const outcome = track(watch.untilStopped(both, timeoutMs, () => false));
      await publish(agentDone(a1, 1200));

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(outcome.status).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.status).toBe("rejected");
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain("no finished Agent call");
      expect((outcome.error as Error).message).toContain(`within ${timeoutMs} ms`);
    });

    it("keeps waiting past the timeout while held", async () => {
      let held = true;
      const outcome = track(watch.untilStopped(both, timeoutMs, () => held));

      await vi.advanceTimersByTimeAsync(timeoutMs * 3);
      expect(outcome.status).toBe("pending");

      held = false;
      await publish(agentDone(a1, 1200), agentDone(a2, 1300));
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
    it("resolves with the Stop after the last finished call once the session is quiet", async () => {
      await publish(agentDone(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));
      const settle = stop(1300);

      await publish(settle);
      await vi.advanceTimersByTimeAsync(quietMs - 1);
      expect(outcome.status).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("does not settle on a Stop stamped before the last finished call", async () => {
      await publish(stop(1100), agentDone(a1, 1200));
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
      await publish(agentDone(a1, 1200));
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
      await publish(agentDone(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));

      await publish(stop(1300));
      await vi.advanceTimersByTimeAsync(quietMs / 2);
      await publish(agentDone(a2, 1400));
      await vi.advanceTimersByTimeAsync(quietMs * 3);
      expect(outcome.status).toBe("pending");

      const settle = stop(1500);
      await publish(settle);
      await vi.advanceTimersByTimeAsync(quietMs);
      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("keeps the window when a duplicate finished call arrives during it", async () => {
      await publish(agentDone(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));
      const settle = stop(1300);

      await publish(settle);
      await vi.advanceTimersByTimeAsync(quietMs / 2);
      await publish(agentDone(a1, 1400));
      await vi.advanceTimersByTimeAsync(quietMs / 2);

      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(settle.payload);
    });

    it("counts a Stop that arrived before the call", async () => {
      const settle = stop(1300);
      await publish(agentDone(a1, 1200), settle);

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

  describe("a turn that fails", () => {
    const never = () => false;

    it("rejects untilStopped with the session's message", async () => {
      const outcome = track(watch.untilStopped(never, longTimeoutMs, never));

      await publish(agentDone(a1, 1200), stopFailure(1300));

      expect(outcome.status).toBe("rejected");
      expect((outcome.error as Error).message).toBe(notLoggedIn);
    });

    it("rejects untilStopped at once when the failure arrived before the call", async () => {
      await publish(stopFailure(1300));

      const outcome = track(watch.untilStopped(never, longTimeoutMs, never));
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.status).toBe("rejected");
      expect((outcome.error as Error).message).toBe(notLoggedIn);
    });

    it("rejects untilStopped while held, since the turn is over", async () => {
      const outcome = track(watch.untilStopped(never, longTimeoutMs, () => true));

      await publish(stopFailure(1300));

      expect(outcome.status).toBe("rejected");
    });

    it("rejects settled with the session's message", async () => {
      await publish(agentDone(a1, 1200));
      const outcome = track(watch.settled(quietMs, longTimeoutMs));

      await publish(stopFailure(1300));

      expect(outcome.status).toBe("rejected");
      expect((outcome.error as Error).message).toBe(notLoggedIn);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      { name: "stamped before the arm time", event: () => stopFailure(armedAt - 1) },
      { name: "for another session", event: () => stopFailure(1300, other) },
    ])("ignores a StopFailure $name", async ({ event }) => {
      const waiting = track(watch.untilStopped(never, longTimeoutMs, never));
      const settling = track(watch.settled(quietMs, longTimeoutMs));

      await publish(event());

      expect(waiting.status).toBe("pending");
      expect(settling.status).toBe("pending");
    });
  });

  describe("close", () => {
    it("releases its four subscriptions and every timer", async () => {
      track(
        watch.untilStopped(
          () => false,
          timeoutMs,
          () => false,
        ),
      );
      await publish(agentDone(a1, 1200), stop(1300));
      const settling: Outcome<TurnEndEvent> = track(watch.settled(quietMs, longTimeoutMs));
      expect(settling.status).toBe("pending");

      watch.close();

      expect(
        new Set(events.subscribe.mock.calls.map(([kind, sessionId]) => `${kind}:${sessionId}`)),
      ).toEqual(
        new Set([
          `Stop:${ours}`,
          `StopFailure:${ours}`,
          `PostToolUse:${ours}`,
          `PreToolUse:${ours}`,
        ]),
      );
      expect(unsubscribes).toHaveLength(4);
      for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
