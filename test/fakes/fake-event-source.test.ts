import { describe, expect, it } from "vitest";
import type { HookEvent } from "../../src/ports/event-source.js";
import { FakeEventSource } from "./fake-event-source.js";

const stop: HookEvent = { kind: "Stop", sessionId: "s1", payload: { session_id: "s1" } };

describe("FakeEventSource", () => {
  it("delivers a published event to a subscriber of the same kind and session", () => {
    const source = new FakeEventSource();
    const received: HookEvent[] = [];
    source.subscribe("Stop", "s1", (event) => received.push(event));

    source.publish(stop);

    expect(received).toEqual([stop]);
  });

  it("does not deliver to a subscriber of another kind or another session", () => {
    const source = new FakeEventSource();
    const received: HookEvent[] = [];
    source.subscribe("PreToolUse", "s1", (event) => received.push(event));
    source.subscribe("Stop", "s2", (event) => received.push(event));

    source.publish(stop);

    expect(received).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const source = new FakeEventSource();
    const received: HookEvent[] = [];
    const unsubscribe = source.subscribe("Stop", "s1", (event) => received.push(event));
    source.publish(stop);

    unsubscribe();
    source.publish(stop);

    expect(received).toEqual([stop]);
  });
});
