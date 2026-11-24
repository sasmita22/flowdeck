import { beforeEach, describe, expect, it } from "vitest";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import { SessionWatch, sessionFailureOf } from "../../../src/core/run/session-watch.js";
import type { NodeState } from "../../../src/core/run/state.js";
import type { EventEntry } from "../../../src/core/run/store.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";

const ours = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const prefix = "fix-login-android";
const start = "android-start";
const a1 = "android-a1";
const a2 = "android-a2";
const stopNode = "android-stop";
const iosAgent = "ios-a1";

const then = (from: string, to: string, port = "out") => ({
  kind: "then" as const,
  from: { node: from, port },
  to: { node: to, port: "in" },
});

const container = {
  prefix,
  nodes: [
    { id: start, type: "trigger" as const, label: "Start" },
    { id: a1, type: "agent" as const, label: "Plan" },
    { id: a2, type: "agent" as const, label: "Build" },
    { id: stopNode, type: "output" as const, label: "Stop" },
  ],
  wires: [then(start, a1), then(a1, a2), then(a2, stopNode)],
};

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
  subagent_type: `${prefix}:${nodeId}`,
  description: "Run",
  prompt: `NODE ${nodeId}\nGo`,
});

const agentCall = (nodeId: string, at: number, sessionId = ours) =>
  hookEvent(
    "PreToolUse",
    at,
    { tool_name: "Agent", tool_input: agentInput(nodeId), tool_use_id: `toolu-${nodeId}` },
    sessionId,
  );

const agentDone = (nodeId: string, at: number, sessionId = ours) =>
  hookEvent(
    "PostToolUse",
    at,
    {
      tool_name: "Agent",
      tool_input: agentInput(nodeId),
      tool_use_id: `toolu-${nodeId}`,
      tool_response: {
        status: "completed",
        agentId: `agent-${nodeId}`,
        agentType: `${prefix}:${nodeId}`,
        content: [{ type: "text", text: `${nodeId} finished` }],
      },
    },
    sessionId,
  );

const bash = (at: number, sessionId = ours) =>
  hookEvent("PreToolUse", at, { tool_name: "Bash", tool_input: { command: "ls" } }, sessionId);

const stop = (at: number, sessionId = ours) =>
  hookEvent("Stop", at, { last_assistant_message: "all done" }, sessionId);

const stopFailure = (at: number, sessionId = ours) =>
  hookEvent(
    "StopFailure",
    at,
    { error: "authentication_failed", last_assistant_message: "Not logged in" },
    sessionId,
  );

describe("SessionWatch", () => {
  let watch: SessionWatch;
  let emitted: EventEntry[];

  const accept = (...events: HookEvent[]) => {
    for (const event of events) emitted.push(...watch.accept(event));
  };

  const died = () => emitted.push(...watch.died());

  const statusOf = (nodeId: string): NodeState =>
    nodeStatus(emitted.filter((entry) => entry.nodeId === nodeId).map((entry) => entry.event));

  const statuses = () => Object.fromEntries(container.nodes.map(({ id }) => [id, statusOf(id)]));

  beforeEach(() => {
    watch = new SessionWatch({ container, sessionId: ours });
    emitted = [];
  });

  it("emits nothing and is not started before its session's first hook event", () => {
    expect(watch.started).toBe(false);
    expect(emitted).toEqual([]);
  });

  it.each([
    { name: "a Bash call", first: () => bash(1000) },
    { name: "a turn-end Stop", first: () => stop(1000) },
  ])("marks Start done and the session started on its first hook event, $name", ({ first }) => {
    accept(first());

    expect(watch.started).toBe(true);
    expect(statusOf(start)).toBe("done");
    expect(statusOf(a1)).toBe("waiting");
    expect(statusOf(a2)).toBe("waiting");
  });

  it("runs each Agent node from its NODE marker's call and finishes it on the call's result", () => {
    accept(bash(1000), agentCall(a1, 1100));
    expect(statusOf(a1)).toBe("running");

    accept(agentDone(a1, 1200));
    expect(statusOf(a1)).toBe("done");
    expect(statusOf(a2)).toBe("waiting");

    accept(agentCall(a2, 1300));
    expect(statusOf(a2)).toBe("running");

    accept(agentDone(a2, 1400));
    expect(statusOf(a2)).toBe("done");
  });

  it("marks the Stop node done on the turn-end Stop after the run prompt", () => {
    accept(bash(1000), agentCall(a1, 1100), agentDone(a1, 1200));
    accept(agentCall(a2, 1300), agentDone(a2, 1400), stop(1500));

    expect(statuses()).toEqual({ [start]: "done", [a1]: "done", [a2]: "done", [stopNode]: "done" });
  });

  it("emits only legal moves when hooks repeat a call result and a Stop", () => {
    accept(bash(1000), agentCall(a1, 1100), agentDone(a1, 1200), agentDone(a1, 1250));
    accept(agentCall(a2, 1300), agentDone(a2, 1400), stop(1500), stop(1600));

    expect(statuses()).toEqual({ [start]: "done", [a1]: "done", [a2]: "done", [stopNode]: "done" });
  });

  describe("a session that ends its turn with work left", () => {
    it("records nothing for a Stop between two nodes and keeps listening", () => {
      accept(bash(1000), agentCall(a1, 1100), agentDone(a1, 1200));

      expect(watch.accept(stop(1300))).toEqual([]);
      expect(statusOf(stopNode)).toBe("waiting");
      expect(watch.accept(agentCall(a2, 1400))).toEqual([
        { nodeId: a2, event: { kind: "running" } },
      ]);
    });

    it("finishes once the remaining node is done and the next turn ends", () => {
      accept(bash(1000), agentCall(a1, 1100), agentDone(a1, 1200), stop(1300));

      accept(agentCall(a2, 1400), agentDone(a2, 1500));
      const before = emitted.length;
      accept(stop(1600));

      expect(emitted.slice(before)).toEqual([
        { nodeId: stopNode, event: { kind: "running" } },
        { nodeId: stopNode, event: { kind: "done" } },
      ]);
      expect(statuses()).toEqual({
        [start]: "done",
        [a1]: "done",
        [a2]: "done",
        [stopNode]: "done",
      });
    });

    it("finishes a branch session whose untaken side never ran", () => {
      const ask = "android-branch";
      const branched = {
        prefix,
        nodes: [
          { id: start, type: "trigger" as const, label: "Start" },
          { id: ask, type: "branch" as const, label: "Ready?" },
          { id: a1, type: "agent" as const, label: "Plan" },
          { id: a2, type: "agent" as const, label: "Build" },
          { id: stopNode, type: "output" as const, label: "Stop" },
        ],
        wires: [
          then(start, ask),
          then(ask, a1, "yes"),
          then(ask, a2, "no"),
          then(a1, stopNode),
          then(a2, stopNode),
        ],
      };
      watch = new SessionWatch({ container: branched, sessionId: ours });

      accept(bash(1000), agentCall(a1, 1100), agentDone(a1, 1200), stop(1300));

      expect(statusOf(stopNode)).toBe("done");
      expect(statusOf(a2)).toBe("waiting");
    });

    it("follows the same rule for a session resumed from its history", () => {
      const history = [
        { nodeId: start, seq: 1, time: "t1", kind: "running" as const },
        { nodeId: start, seq: 2, time: "t2", kind: "done" as const },
        { nodeId: a1, seq: 3, time: "t3", kind: "running" as const },
        { nodeId: a1, seq: 4, time: "t4", kind: "done" as const },
      ];
      watch.seed(history);

      accept(stop(2000));
      expect(emitted).toEqual([]);

      accept(agentCall(a2, 2100), agentDone(a2, 2200), stop(2300));
      expect(statusOf(stopNode)).toBe("done");
    });

    it("fails the Stop as ended before it when its tmux session is gone after a mid-flow Stop", () => {
      accept(bash(1000), agentCall(a1, 1100), agentDone(a1, 1200), stop(1300));

      died();

      expect(statusOf(stopNode)).toBe("failed");
      expect(emitted.at(-1)).toEqual({
        nodeId: stopNode,
        event: { kind: "failed", payload: { message: `session ${ours} ended before its Stop` } },
      });
    });
  });

  describe("a session that fails", () => {
    it("fails the node whose marker is open on a StopFailure", () => {
      accept(agentCall(a1, 1100), agentDone(a1, 1200), agentCall(a2, 1300), stopFailure(1400));

      expect(statusOf(a2)).toBe("failed");
      expect(statusOf(stopNode)).toBe("waiting");
    });

    it("fails the Stop node on a StopFailure with no marker open", () => {
      accept(agentCall(a1, 1100), agentDone(a1, 1200), stopFailure(1300));

      expect(statusOf(a1)).toBe("done");
      expect(statusOf(stopNode)).toBe("failed");
    });

    it("fails the open node when its tmux session is gone before Stop", () => {
      accept(agentCall(a1, 1100));

      died();

      expect(statusOf(a1)).toBe("failed");
      expect(statusOf(stopNode)).toBe("waiting");
    });

    it("fails the Stop node when its tmux session is gone before Stop with no marker open", () => {
      accept(agentCall(a1, 1100), agentDone(a1, 1200));

      died();

      expect(statusOf(stopNode)).toBe("failed");
    });

    it("fails the node it is told to, then emits nothing for a death or any later event", () => {
      accept(agentCall(a1, 1100), agentDone(a1, 1200));

      emitted.push(...watch.failAt(a2, "tmux: no server running"));
      const before = emitted.length;
      died();
      accept(agentCall(a2, 1300), agentDone(a2, 1400), stop(1500));

      expect(statusOf(a2)).toBe("failed");
      expect(emitted.at(before - 1)).toEqual({
        nodeId: a2,
        event: { kind: "failed", payload: { message: "tmux: no server running" } },
      });
      expect(emitted).toHaveLength(before);
      expect(statusOf(stopNode)).toBe("waiting");
    });

    it("fails nothing when its tmux session is gone after Stop", () => {
      accept(agentCall(a1, 1100), agentDone(a1, 1200), agentCall(a2, 1250), agentDone(a2, 1280));
      accept(stop(1300));
      const before = emitted.length;

      died();

      expect(emitted).toHaveLength(before);
      expect(statusOf(stopNode)).toBe("done");
    });
  });

  describe("parallel Agent nodes dispatched in one message", () => {
    const fork = "android-fork";
    const join = "android-join";
    const forked = {
      prefix,
      nodes: [
        { id: start, type: "trigger" as const, label: "Start" },
        { id: fork, type: "fork" as const, label: "Fork" },
        { id: a1, type: "agent" as const, label: "Plan" },
        { id: a2, type: "agent" as const, label: "Build" },
        { id: join, type: "join" as const, label: "Join" },
        { id: stopNode, type: "output" as const, label: "Stop" },
      ],
      wires: [
        then(start, fork),
        then(fork, a1),
        then(fork, a2),
        then(a1, join),
        then(a2, join),
        then(join, stopNode),
      ],
    };

    beforeEach(() => {
      watch = new SessionWatch({ container: forked, sessionId: ours });
    });

    it("finishes the first branch's node and keeps its sibling running", () => {
      accept(agentCall(a1, 1100), agentCall(a2, 1110), agentDone(a1, 1200));

      expect(statusOf(a1)).toBe("done");
      expect(statusOf(a2)).toBe("running");
      expect(emitted.filter((entry) => entry.nodeId === a1)).toEqual([
        { nodeId: a1, event: { kind: "running" } },
        { nodeId: a1, event: { kind: "done" } },
      ]);
    });

    it("records nothing for a Stop while a sibling still runs, then finishes after it", () => {
      accept(agentCall(a1, 1100), agentCall(a2, 1110), agentDone(a1, 1200));

      expect(watch.accept(stop(1300))).toEqual([]);
      expect(statusOf(stopNode)).toBe("waiting");

      accept(agentDone(a2, 1400), stop(1500));
      expect(statusOf(stopNode)).toBe("done");
    });

    it("fails the sibling still running when its tmux session is gone", () => {
      accept(agentCall(a1, 1100), agentCall(a2, 1110), agentDone(a1, 1200));

      died();

      expect(statusOf(a2)).toBe("failed");
      expect(statusOf(stopNode)).toBe("waiting");
    });

    it("fails every node still running when its tmux session is gone", () => {
      accept(agentCall(a1, 1100), agentCall(a2, 1110));

      died();

      expect(statusOf(a1)).toBe("failed");
      expect(statusOf(a2)).toBe("failed");
      expect(statusOf(stopNode)).toBe("waiting");
    });

    it("keeps every running node open for a session resumed from its history", () => {
      const history = [
        { nodeId: start, seq: 1, time: "t1", kind: "running" as const },
        { nodeId: start, seq: 2, time: "t2", kind: "done" as const },
        { nodeId: a1, seq: 3, time: "t3", kind: "running" as const },
        { nodeId: a2, seq: 4, time: "t4", kind: "running" as const },
      ];
      watch.seed(history);

      expect(watch.accept(agentDone(a1, 2000))).toEqual([{ nodeId: a1, event: { kind: "done" } }]);
    });

    describe("the node a permission ask comes from", () => {
      const shared = `${prefix}:shared`;
      const sharedCall = (nodeId: string, at: number) =>
        hookEvent("PreToolUse", at, {
          tool_name: "Agent",
          tool_input: { ...agentInput(nodeId), subagent_type: shared },
          tool_use_id: `toolu-${nodeId}`,
        });
      const ask = (fields: Record<string, unknown> = {}) => ({
        tool_name: "Bash",
        tool_input: { command: "git push" },
        ...fields,
      });

      it("reports each open node's Agent call", () => {
        accept(agentCall(a1, 1100), agentCall(a2, 1110));

        expect(watch.openCalls).toEqual([
          { nodeId: a1, toolUseId: `toolu-${a1}`, agentType: `${prefix}:${a1}` },
          { nodeId: a2, toolUseId: `toolu-${a2}`, agentType: `${prefix}:${a2}` },
        ]);
      });

      it("picks the first open node for an ask from the main thread", () => {
        accept(agentCall(a1, 1100), agentCall(a2, 1110));

        expect(watch.askingNode(ask())).toEqual({ node: a1 });
      });

      it("picks the open node whose Agent type matches the asking subagent's", () => {
        accept(agentCall(a1, 1100), agentCall(a2, 1110));

        expect(
          watch.askingNode(ask({ agent_id: "a2acfd3c49ca63d33", agent_type: `${prefix}:${a2}` })),
        ).toEqual({ node: a2 });
      });

      it("names every open node when the asking subagent's type matches more than one", () => {
        accept(sharedCall(a1, 1100), sharedCall(a2, 1110));

        expect(
          watch.askingNode(ask({ agent_id: "a2acfd3c49ca63d33", agent_type: shared })),
        ).toEqual({ candidates: [a1, a2] });
      });

      it("names every open node when the asking subagent has no type and a resumed node has no call", () => {
        watch.seed([
          { nodeId: start, seq: 1, time: "t1", kind: "running" },
          { nodeId: start, seq: 2, time: "t2", kind: "done" },
          { nodeId: a1, seq: 3, time: "t3", kind: "running" },
        ]);
        accept(agentCall(a2, 2000));

        expect(watch.askingNode(ask({ agent_id: "a2acfd3c49ca63d33" }))).toEqual({
          candidates: [a1, a2],
        });
      });

      it("picks the only open node whatever the asking subagent's type", () => {
        accept(agentCall(a1, 1100));

        expect(
          watch.askingNode(ask({ agent_id: "a2acfd3c49ca63d33", agent_type: "general-purpose" })),
        ).toEqual({ node: a1 });
      });
    });
  });

  describe("events that are not its session's", () => {
    it.each([
      { name: "a Bash call", event: bash(1000, other) },
      { name: "an Agent call", event: agentCall(a1, 1100, other) },
      { name: "an Agent result", event: agentDone(a1, 1200, other) },
      { name: "a Stop", event: stop(1300, other) },
      { name: "a StopFailure", event: stopFailure(1300, other) },
    ])("ignores another session's $name", ({ event }) => {
      accept(event);

      expect(watch.started).toBe(false);
      expect(emitted).toEqual([]);
    });

    it.each([
      { name: "call", event: agentCall(iosAgent, 1100) },
      { name: "result", event: agentDone(iosAgent, 1200) },
    ])("ignores an Agent $name marked with another container's node", ({ event }) => {
      accept(bash(1000));
      const before = emitted.length;

      accept(event);

      expect(emitted).toHaveLength(before);
      expect(emitted.map((entry) => entry.nodeId)).not.toContain(iosAgent);
    });
  });
});

describe("sessionFailureOf", () => {
  const stage = (nodeId: string, label: string, status: NodeState) => ({
    nodeId,
    type: "agent" as const,
    label,
    status,
    retries: 0,
    decisions: [],
    timeline: [],
    activity: [],
  });

  type Groups = Parameters<typeof sessionFailureOf>[0];

  const group = (name: string, items: ReturnType<typeof stage>[]) => ({ name, items });

  const groups = (...list: ReturnType<typeof group>[]) => list as unknown as Groups;

  it("names the container and node of the first failed node in a session group", () => {
    const result = sessionFailureOf(
      groups(
        group("workspace", [stage("ws-a1", "Plan", "done")]),
        group("android", [stage(a1, "Plan", "done"), stage(a2, "Build", "failed")]),
        group("ios", [stage(iosAgent, "Review", "failed")]),
      ),
    );

    expect(result).toEqual({ container: "android", node: "Build" });
  });

  it("gives nothing when no session node failed", () => {
    expect(
      sessionFailureOf(
        groups(
          group("workspace", [stage("ws-a1", "Plan", "done")]),
          group("android", [stage(a1, "Plan", "done"), stage(a2, "Build", "waiting")]),
        ),
      ),
    ).toBeUndefined();
  });

  it("leaves a failed workspace node to the workspace's own outcome", () => {
    expect(
      sessionFailureOf(
        groups(
          group("workspace", [stage("ws-a1", "Plan", "failed")]),
          group("android", [stage(a1, "Plan", "done")]),
        ),
      ),
    ).toBeUndefined();
  });
});
