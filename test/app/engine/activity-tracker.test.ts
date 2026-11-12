import { beforeEach, describe, expect, it } from "vitest";
import {
  createActivityTracker,
  createBuildActivity,
} from "../../../src/app/engine/activity-tracker.js";
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
    kind: "PreToolUse" | "PostToolUse" | "SubagentStop",
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
    hook("PreToolUse", at, {
      tool_name: "Agent",
      tool_input: { description: "Look" },
      tool_use_id: "toolu_1",
    });

  const agentDone = (at: number) =>
    hook("PostToolUse", at, {
      tool_name: "Agent",
      tool_input: { description: "Look" },
      tool_use_id: "toolu_1",
      tool_response: { status: "completed", agentId: "agent-1", agentType: "general-purpose" },
    });

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
      buildId: "b1",
    }).id;
    const tracker = createActivityTracker({
      runId,
      now: () => clock,
      publish: (push) => publish(push),
      log: (line) => logs.push(line),
      activity: inner,
      turnNodes: new Set(["p2"]),
      place: { cwd: "/repo", home: "/Users/me" },
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
    const build = {
      id: "h1",
      hash: "h1",
      name: "b1",
      repo: "/repo",
      base: "main",
      values: {},
      dir: "/fd-home/workspaces/h1",
      files: [],
      nodes: [],
    };
    store.recordBuild(build);
    store.recordCost(runId, 0.25);

    expect(store.findRun(runId)).toEqual(inner.findRun(runId));
    expect(inner.findRun(runId)?.status).toBe("done");
    expect(inner.builds()).toEqual([build]);
    expect(inner.costOf(runId)).toBe(0.25);
    expect(store.listBuilds()).toEqual(inner.listBuilds());
    expect(store.findBuild("h1")).toEqual(inner.findBuild("h1"));
    expect(store.findBuildByName("b1")).toEqual(inner.findBuildByName("b1"));
    expect(store.buildFiles("h1")).toEqual(inner.buildFiles("h1"));
    expect(store.listRuns()).toEqual(inner.listRuns());
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

  it("shows a written file relative to the run's working folder", () => {
    hook("PreToolUse", 350, { tool_name: "Write", tool_input: { file_path: "/repo/src/a.ts" } });

    expect(activity().map((push) => push.value)).toMatchObject([
      { entry: { kind: "tool", path: "src/a.ts" } },
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
    agentDone(360);

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
            toolUseId: "toolu_1",
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
            toolUseId: "toolu_1",
            agentId: "agent-1",
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

  it("stores each entry it publishes, and stores it again when it changes", () => {
    agent(350);
    agentDone(360);

    expect(inner.activity(runId)).toEqual([
      expect.objectContaining({ id: 1, kind: "subagent", state: "finished" }),
    ]);
  });

  it("writes a turn entry when a turn node is done, and a failure entry when a node fails", () => {
    clock = 400;
    store.append(runId, "p2", { kind: "done", payload: { stopMessage: "All set." } });
    store.appendAll(runId, [
      { nodeId: "p1", event: { kind: "reset" } },
      { nodeId: "p1", event: { kind: "running" } },
      {
        nodeId: "p1",
        event: { kind: "failed", payload: { message: "p1 failed: rejected: wrong scope" } },
      },
    ]);

    expect(activity().map((push) => push.value.entry)).toEqual([
      { id: 1, nodeId: "p2", at: 400, kind: "turn", summary: "All set." },
      { id: 2, nodeId: "p1", at: 400, kind: "failure", summary: "Rejected: wrong scope" },
    ]);
    expect(inner.activity(runId)).toHaveLength(2);
  });

  it("writes a pr entry for the URL gh pr create printed", () => {
    hook("PostToolUse", 350, {
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      tool_response: { stdout: "https://github.com/acme/app/pull/7\n" },
    });

    expect(activity().map((push) => push.value.entry)).toMatchObject([
      { id: 1, nodeId: "p2", kind: "pr", url: "https://github.com/acme/app/pull/7" },
    ]);
  });

  it("numbers new entries after the run's stored ones", () => {
    const stored = new FakeStore();
    const id = stored.createRun({
      buildDir: "/b",
      inputs: {},
      nodeIds: ["p1"],
      session: { tmuxName: "fd-run-test", cwd: "/repo", claudeSessionId: session },
      buildId: "b1",
    }).id;
    stored.recordActivity(id, { id: 7, nodeId: "p1", at: 1, kind: "turn", summary: "old" });
    const tracker = createActivityTracker({
      runId: id,
      now: () => 5,
      publish: (push) => pushes.push(push),
      log: () => undefined,
      activity: stored,
      turnNodes: new Set(),
      place: { cwd: "/repo" },
    });

    tracker.store(stored).append(id, "p1", {
      kind: "failed",
      payload: { message: "p1 failed: boom" },
    });

    expect(stored.activity(id).map((entry) => entry.id)).toEqual([7, 8]);
  });
});

describe("createBuildActivity", () => {
  it("records and pushes nothing for an Agent call that names no piece", () => {
    const store = new FakeStore();
    const pushes: EnginePush[] = [];
    const record = createBuildActivity({
      pendingId: "pending-1",
      now: () => 10,
      activity: store,
      publish: (push) => pushes.push(push),
    });

    record({ toolUseId: "toolu-1", agentType: "general-purpose" });
    record({ background: true, agentId: "a2acfd3c49ca63d33" });

    expect(store.buildActivity("pending-1")).toEqual([]);
    expect(pushes).toEqual([]);
  });
});
