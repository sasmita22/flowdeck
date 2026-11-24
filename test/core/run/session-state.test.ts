import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import { sessionState } from "../../../src/core/run/session-state.js";
import type { EventEntry } from "../../../src/core/run/store.js";

const start = "android-start";
const plan = "android-plan";
const build = "android-build";
const stop = "android-stop";

const session = { nodeIds: [start, plan, build, stop], stopNode: stop };

const at = (nodeId: string, ...kinds: RunEvent[]): EventEntry[] =>
  kinds.map((event) => ({ nodeId, event }));

const running: RunEvent = { kind: "running" };
const done: RunEvent = { kind: "done" };
const needsYou: RunEvent = { kind: "needs-you" };
const failed: RunEvent = { kind: "failed", payload: { message: "ended before its Stop" } };

const started = at(start, running, done);

describe("sessionState", () => {
  it("reads not-started with no events", () => {
    expect(sessionState(session, [])).toBe("not-started");
  });

  it("reads not-started when only other sessions have events", () => {
    expect(sessionState(session, at("ios-start", running, done))).toBe("not-started");
  });

  it("reads running while a node runs and the Stop is not done", () => {
    expect(sessionState(session, [...started, ...at(plan, running)])).toBe("running");
  });

  it("reads waiting while a node waits for a permission answer", () => {
    expect(sessionState(session, [...started, ...at(plan, running, needsYou)])).toBe("waiting");
  });

  it("reads running again once the permission is answered", () => {
    expect(sessionState(session, [...started, ...at(plan, running, needsYou, running)])).toBe(
      "running",
    );
  });

  it("reads running for a node left open after its turn ended for a reply", () => {
    const parked = [...started, ...at(plan, running, done), ...at(build, running)];

    expect(sessionState(session, parked)).toBe("running");
  });

  it("reads done once the Stop node is done", () => {
    const finished = [
      ...started,
      ...at(plan, running, done),
      ...at(build, running, done),
      ...at(stop, running, done),
    ];

    expect(sessionState(session, finished)).toBe("done");
  });

  it("reads failed when a node failed before its Stop", () => {
    expect(sessionState(session, [...started, ...at(build, running, failed)])).toBe("failed");
  });

  it("reads failed when the Stop node failed", () => {
    expect(sessionState(session, [...started, ...at(stop, running, failed)])).toBe("failed");
  });

  it("reads failed over a done Stop", () => {
    const both = [...started, ...at(plan, running, failed), ...at(stop, running, done)];

    expect(sessionState(session, both)).toBe("failed");
  });
});
