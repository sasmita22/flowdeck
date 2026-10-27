import { describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.js";

type TestEvent = { kind: "A" | "B"; sessionId: string };

describe("EventBus", () => {
  it("delivers an event to a handler of the same kind and session, as the same object", () => {
    const bus = new EventBus<TestEvent>();
    const received: TestEvent[] = [];
    bus.subscribe("A", "s1", (event) => received.push(event));
    const event: TestEvent = { kind: "A", sessionId: "s1" };

    bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it("does not deliver an event of another kind or another session", () => {
    const bus = new EventBus<TestEvent>();
    const received: TestEvent[] = [];
    bus.subscribe("A", "s1", (event) => received.push(event));

    bus.publish({ kind: "B", sessionId: "s1" });
    bus.publish({ kind: "A", sessionId: "s2" });

    expect(received).toEqual([]);
  });

  it("delivers to every handler of the same kind and session", () => {
    const bus = new EventBus<TestEvent>();
    const first: TestEvent[] = [];
    const second: TestEvent[] = [];
    bus.subscribe("A", "s1", (event) => first.push(event));
    bus.subscribe("A", "s1", (event) => second.push(event));

    bus.publish({ kind: "A", sessionId: "s1" });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("stops delivering to an unsubscribed handler only", () => {
    const bus = new EventBus<TestEvent>();
    const removed: TestEvent[] = [];
    const kept: TestEvent[] = [];
    const unsubscribe = bus.subscribe("A", "s1", (event) => removed.push(event));
    bus.subscribe("A", "s1", (event) => kept.push(event));

    unsubscribe();
    bus.publish({ kind: "A", sessionId: "s1" });

    expect(removed).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it("publishes with no subscribers without throwing", () => {
    expect(() => new EventBus<TestEvent>().publish({ kind: "A", sessionId: "s1" })).not.toThrow();
  });
});
