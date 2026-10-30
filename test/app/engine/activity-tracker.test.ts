import { beforeEach, describe, expect, it } from "vitest";
import { createActivityTracker } from "../../../src/app/engine/activity-tracker.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { Store } from "../../../src/ports/store.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeStore } from "../../fakes/fake-store.js";

const session = "s1";

describe("createActivityTracker", () => {
  let clock: number;
  let pushes: EnginePush[];
  let logs: string[];
  let publish: (push: EnginePush) => void;
  let inner: FakeStore;
  let runId: string;
  let store: Store;
  let source: FakeEventSource;
  let unwatch: () => void;

  const hook = (
    kind: "PreToolUse" | "SubagentStop",
    at: number,
    fields: Record<string, unknown> = {},
    sessionId = session,
  ) =>
    source.publish({
      kind,
      sessionId,
      payload: { hook_event_name: kind, session_id: sessionId, flowdeck_hook_at: at, ...fields },
    });

  const bash = (at: number, sessionId = session) =>
    hook("PreToolUse", at, { tool_name: "Bash", tool_input: { command: "ls" } }, sessionId);

  const agent = (at: number) =>
    hook("PreToolUse", at, { tool_name: "Agent", tool_input: { description: "Look" } });

  const activity = () => pushes.filter((push) => push.push === "activity");

  beforeEach(() => {
    clock = 0;
    pushes = [];
    logs = [];
    publish = (push) => pushes.push(push);
    inner = new FakeStore();
    runId = inner.createRun({
      buildDir: "/fd-home/builds/b1",
      inputs: {},
      nodeIds: ["p1", "p2"],
      session: { tmuxName: "fd-run-test", cwd: "/repo", claudeSessionId: session },
    }).id;
    const tracker = createActivityTracker({
      runId,
      now: () => clock,
      publish: (push) => publish(push),
      log: (line) => logs.push(line),
    });
    store = tracker.store(inner);
    clock = 100;
    store.append(runId, "p1", { kind: "sent" });
    clock = 200;
    store.append(runId, "p1", { kind: "done" });
    clock = 300;
    store.appendAll(runId, [{ nodeId: "p2", event: { kind: "sent" } }]);
    source = new FakeEventSource();
    unwatch = tracker.watch(source, session);
  });

  it("passes every append through to the inner store unchanged", () => {
    expect(inner.events(runId).map(({ nodeId, kind }) => ({ nodeId, kind }))).toEqual([
      { nodeId: "p1", kind: "sent" },
      { nodeId: "p1", kind: "done" },
      { nodeId: "p2", kind: "sent" },
    ]);
  });

  it("forwards the rest of the store to the inner store", () => {
    store.finishRun(runId, "done");
    store.recordBuild({ hash: "h1", dir: "/fd-home/builds/b1" });

    expect(store.findRun(runId)).toEqual(inner.findRun(runId));
    expect(inner.findRun(runId)?.status).toBe("done");
    expect(inner.builds()).toEqual([{ hash: "h1", dir: "/fd-home/builds/b1" }]);
    expect(store.events(runId)).toEqual(inner.events(runId));
  });

  it("publishes one activity push for the node whose turn holds the stamp", () => {
    bash(350);

    expect(pushes).toEqual([
      {
        push: "activity",
        value: {
          runId,
          entry: { id: 1, nodeId: "p2", at: 350, kind: "tool", tool: "Bash", summary: "ls" },
        },
      },
    ]);
  });

  it("places a stamp from an earlier turn on that turn's node even when it arrives late", () => {
    bash(150);

    expect(activity().map((push) => push.value)).toMatchObject([{ entry: { nodeId: "p1" } }]);
  });

  it("publishes nothing for another session's tool call", () => {
    bash(350, "s2");

    expect(pushes).toEqual([]);
  });

  it("publishes nothing for a stamp between two turns", () => {
    bash(250);

    expect(pushes).toEqual([]);
  });

  it("publishes a running subagent, then only that entry again when it finishes", () => {
    agent(350);
    hook("SubagentStop", 360, { agent_id: "agent-1", agent_type: "general-purpose" });

    expect(pushes).toEqual([
      {
        push: "activity",
        value: {
          runId,
          entry: {
            id: 1,
            nodeId: "p2",
            at: 350,
            kind: "subagent",
            agentType: "general-purpose",
            summary: "Look",
            state: "running",
          },
        },
      },
      {
        push: "activity",
        value: {
          runId,
          entry: {
            id: 1,
            nodeId: "p2",
            at: 350,
            kind: "subagent",
            agentType: "general-purpose",
            summary: "Look",
            state: "finished",
          },
        },
      },
    ]);
  });

  it("logs a publish error instead of throwing it into the event source, and keeps going", () => {
    publish = () => {
      throw new Error("renderer gone");
    };

    expect(() => bash(350)).not.toThrow();
    expect(logs).toEqual([expect.stringContaining("renderer gone")]);

    publish = (push) => pushes.push(push);
    bash(360);

    expect(activity()).toHaveLength(1);
  });

  it("publishes nothing once unwatched", () => {
    agent(350);
    unwatch();

    bash(360);
    hook("SubagentStop", 370, { agent_id: "agent-1", agent_type: "general-purpose" });

    expect(activity()).toHaveLength(1);
  });
});
