import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { waitForTurnEnd, type TurnEndEvent, type TurnEvents } from "../../../src/core/run/turns.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";

const ours = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const timeoutMs = 5000;

type Outcome = {
  status: "pending" | "resolved" | "rejected";
  value?: TurnEndEvent;
  error?: unknown;
};

function track(promise: Promise<TurnEndEvent>): Outcome {
  const outcome: Outcome = { status: "pending" };
  promise.then(
    (value) => Object.assign(outcome, { status: "resolved", value }),
    (error: unknown) => Object.assign(outcome, { status: "rejected", error }),
  );
  return outcome;
}

const hookEvent = (kind: HookEventKind, sessionId: string): HookEvent => ({
  kind,
  sessionId,
  payload: { hook_event_name: kind, session_id: sessionId },
});

describe("waitForTurnEnd", () => {
  let source: FakeEventSource;
  let unsubscribes: Mock<() => void>[];
  let events: TurnEvents & { subscribe: Mock<TurnEvents["subscribe"]> };

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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with our session's Stop event", async () => {
    const stop = hookEvent("Stop", ours);
    const outcome = track(waitForTurnEnd(events, ours, timeoutMs));

    source.publish(stop);
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.status).toBe("resolved");
    expect(outcome.value?.sessionId).toBe(ours);
    expect(outcome.value?.payload).toBe(stop.payload);
  });

  it("ignores another session's Stop and resolves on ours", async () => {
    const stop = hookEvent("Stop", ours);
    const outcome = track(waitForTurnEnd(events, ours, timeoutMs));

    source.publish(hookEvent("Stop", other));
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.status).toBe("pending");

    source.publish(stop);
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.status).toBe("resolved");
    expect(outcome.value?.sessionId).toBe(ours);
    expect(outcome.value?.payload).toBe(stop.payload);
  });

  it.each<HookEventKind>(["PreToolUse", "PostToolUse", "SubagentStop"])(
    "ignores %s for our session",
    async (kind) => {
      const outcome = track(waitForTurnEnd(events, ours, timeoutMs));

      source.publish(hookEvent(kind, ours));
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.status).toBe("pending");
    },
  );

  it("rejects naming the session and the timeout when no Stop arrives in time", async () => {
    const outcome = track(waitForTurnEnd(events, ours, timeoutMs));

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(outcome.status).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toContain(ours);
    expect((outcome.error as Error).message).toContain(String(timeoutMs));
  });

  describe("armed at a time", () => {
    const armedAt = 1000;
    const stampedStop = (hookAt?: number): HookEvent => {
      const stop = hookEvent("Stop", ours);
      return hookAt === undefined
        ? stop
        : { ...stop, payload: { ...stop.payload, flowdeck_hook_at: hookAt } };
    };

    it("ignores a Stop stamped before it was armed", async () => {
      const outcome = track(waitForTurnEnd(events, ours, timeoutMs, armedAt));

      source.publish(stampedStop(armedAt - 1));
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.status).toBe("pending");
    });

    it.each([
      { name: "at the arm time", hookAt: armedAt },
      { name: "after the arm time", hookAt: armedAt + 1 },
      { name: "with no stamp", hookAt: undefined },
    ])("resolves on a Stop stamped $name", async ({ hookAt }) => {
      const stop = stampedStop(hookAt);
      const outcome = track(waitForTurnEnd(events, ours, timeoutMs, armedAt));

      source.publish(stop);
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.status).toBe("resolved");
      expect(outcome.value?.payload).toBe(stop.payload);
    });
  });

  it("releases its subscription and its timer once resolved", async () => {
    track(waitForTurnEnd(events, ours, timeoutMs));

    source.publish(hookEvent("Stop", ours));
    await vi.advanceTimersByTimeAsync(0);

    expect(events.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases its subscription and its timer once timed out", async () => {
    track(waitForTurnEnd(events, ours, timeoutMs));

    await vi.advanceTimersByTimeAsync(timeoutMs);

    expect(events.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("turns.ts source", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src/core/run/turns.ts", import.meta.url)),
    "utf8",
  );

  it("waits for the event, not on an interval", () => {
    expect(source.match(/\bsetInterval\b/g) ?? []).toHaveLength(0);
  });

  it("has no timer other than the timeout", () => {
    expect((source.match(/\bsetTimeout\s*\(/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});
