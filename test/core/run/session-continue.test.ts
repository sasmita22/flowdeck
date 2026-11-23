import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import { sessionContinuePrompt } from "../../../src/core/run/session-continue.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

const node = (id: string, type: ManifestNode["type"], label: string) =>
  ({ id, type, label, settings: {} }) as ManifestNode;

const android = {
  prefix: "fix-login-android",
  nodes: [
    node("session-1-start", "trigger", "Start"),
    node("session-1-plan", "agent", "Plan"),
    node("session-1-build", "agent", "Build"),
    node("session-1-stop", "output", "Stop"),
  ],
};

const running: RunEvent = { kind: "running" };
const done: RunEvent = { kind: "done" };

const stored = (entries: [string, RunEvent][]): StoredEvent[] =>
  entries.map(([nodeId, event], i) => ({ ...event, nodeId, seq: i + 1, time: "t" }));

describe("sessionContinuePrompt", () => {
  it("runs the session's command again, naming the done nodes and the first unfinished one", () => {
    const events = stored([
      ["workspace-1-wait", { kind: "sent" }],
      ["session-1-start", running],
      ["session-1-start", done],
      ["session-1-plan", running],
      ["session-1-plan", done],
    ]);

    expect(sessionContinuePrompt(android, events)).toBe(
      "/fix-login-android:run Already done: NODE session-1-start (Start), NODE session-1-plan (Plan). Carry on from NODE session-1-build (Build); do not redo the done steps.",
    );
  });

  it("carries on from Stop when every other node is done", () => {
    const events = stored(
      ["session-1-start", "session-1-plan", "session-1-build"].flatMap(
        (id): [string, RunEvent][] => [
          [id, running],
          [id, done],
        ],
      ),
    );

    expect(sessionContinuePrompt(android, events)).toBe(
      "/fix-login-android:run Already done: NODE session-1-start (Start), NODE session-1-plan (Plan), NODE session-1-build (Build). Carry on from NODE session-1-stop (Stop); do not redo the done steps.",
    );
  });
});
