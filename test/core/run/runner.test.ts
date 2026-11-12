import { describe, expect, it, vi } from "vitest";
import { lower, type ManifestNode } from "../../../src/core/compiler/lower.js";
import { agentTurnText } from "../../../src/core/nodes/agent/execute.js";
import { forkTurnText } from "../../../src/core/nodes/fork/execute.js";
import { hardstopCheckTurn } from "../../../src/core/nodes/hardstop/execute.js";
import {
  agentVerdictTurnText,
  capRequest,
  malformedRequest,
  verdictRequest,
} from "../../../src/core/nodes/loop/execute.js";
import {
  Runner,
  StructureError,
  structureProblems,
  type RunnerDeps,
  type RunnableManifest,
  type RunOptions,
} from "../../../src/core/run/runner.js";
import type { ResumeActions } from "../../../src/core/run/resume.js";
import { retryEntries } from "../../../src/core/run/retry.js";
import { decisionsOf, nodeStatus, type RunEvent } from "../../../src/core/run/run-events.js";
import type { UsageEntry } from "../../../src/ports/usage-source.js";
import type { WaitReply, WaitRequest } from "../../../src/ports/waiter.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeUsageSource } from "../../fakes/fake-usage-source.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import * as builders from "../../fixtures/flow-builders.js";
import { budget as budgetWait, permission as permissionWait } from "../../fixtures/waits.js";

const hash = "abc123";
const prefix = "fix-login";
const sessionId = "s1";
const cwd = "/repo";

const node = (id: string, type: ManifestNode["type"], settings: Record<string, unknown> = {}) =>
  ({ id, type, label: id, settings }) as ManifestNode;
const forEach = (id: string) => node(id, "foreach", { file: "plan.md" });
const inEach = (child: ManifestNode, parent = "e1"): ManifestNode => ({ ...child, parent });
const manifest = (...nodes: ManifestNode[]): RunnableManifest => ({ hash, prefix, nodes });

type TestDeps = Omit<RunnerDeps, "runId"> & { store: FakeStore };

const newRun = (m: RunnableManifest) => ({
  buildDir: "/fd/builds/abc",
  inputs: {},
  nodeIds: m.nodes.map((each) => each.id),
  session: { tmuxName: "fd-run", cwd, claudeSessionId: sessionId },
  buildId: hash,
});

function runOn(deps: TestDeps, m: RunnableManifest, options?: RunOptions) {
  const { id } = deps.store.createRun(newRun(m));
  return new Runner({ ...deps, runId: id }).run(m, options);
}

type StopTiming = "during-send" | "after-send" | "never";

function harness(
  options: {
    stop?: StopTiming;
    waiter?: FakeWaiter;
    auto?: boolean;
    flags?: Record<string, boolean>;
    replies?: (string | undefined)[];
    permissions?: FakePermissionSource;
    usage?: FakeUsageSource;
    budget?: number;
    files?: FakeFileSystem;
  } = {},
) {
  const events = new FakeEventSource();
  const files = options.files ?? new FakeFileSystem();
  const calls: string[] = [];
  const lines: string[] = [];
  const stop = options.stop ?? "after-send";
  let stops = 0;
  const publishStop = (text: string) => {
    const dispatched = /subagent_type "([^"]+)" and the prompt "NODE ([^\\"]+)/.exec(text);
    if (dispatched !== null) {
      const [, agentType = "", nodeId = ""] = dispatched;
      events.publish({
        kind: "PostToolUse",
        sessionId,
        payload: agentDonePayload(nodeId, agentType),
      });
    }
    const reply = options.replies?.[stops++];
    events.publish({
      kind: "Stop",
      sessionId,
      payload: typeof reply === "string" ? { last_assistant_message: reply } : {},
    });
  };
  const deps: TestDeps = {
    store: new FakeStore(),
    prompts: {
      interrupt: async () => undefined,
      sendPrompt: async (text) => {
        calls.push(`send ${text}`);
        if (stop === "during-send") publishStop(text);
        if (stop === "after-send") setTimeout(() => publishStop(text), 0);
      },
    },
    session: {
      ensureStarted: async () => {
        calls.push("start");
      },
    },
    events,
    waiter: options.waiter ?? new FakeWaiter([]),
    ...(options.auto === undefined ? {} : { auto: options.auto }),
    ...(options.flags === undefined ? {} : { flags: options.flags }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    files,
    onChange: (line) => lines.push(line),
    cwd,
    sessionId,
    turnTimeoutMs: 1000,
  };
  return { deps, events, calls, lines, files };
}

type Emitted =
  | { kind: "Stop"; reply?: string }
  | { kind: "AgentDone"; nodeId?: string; agentType: string; reply?: string }
  | { kind: "StopFailure"; error: string; reply?: string };

const stopped: Emitted = { kind: "Stop" };
const notLoggedIn = "Not logged in · Please run /login";
const failedTurn: Emitted = {
  kind: "StopFailure",
  error: "authentication_failed",
  reply: notLoggedIn,
};
const agentDone = (nodeId: string | undefined, agentType = `${prefix}:${nodeId}`): Emitted => ({
  kind: "AgentDone",
  agentType,
  ...(nodeId === undefined ? {} : { nodeId }),
});
const agentDonePayload = (
  nodeId: string | undefined,
  agentType = `${prefix}:${nodeId}`,
  reply?: string,
) => {
  const input = {
    subagent_type: agentType,
    prompt: nodeId === undefined ? "Go" : `NODE ${nodeId}\nGo`,
  };
  return {
    tool_name: "Agent",
    tool_input: input,
    tool_use_id: `toolu-${nodeId ?? "none"}`,
    tool_response: {
      status: "completed",
      agentId: `agent-${nodeId ?? "none"}`,
      agentType,
      content: reply === undefined ? [] : [{ type: "text", text: reply }],
    },
  };
};
const bare = (id: string) => ({ id, given: [], writes: [] });
const turnOf = (
  id: string,
  extra: { answers?: string[]; condition?: string; item?: string } = {},
) => {
  const answers = extra.answers ?? [];
  const text =
    extra.condition === undefined
      ? agentTurnText(prefix, id, bare(id), extra.item, answers)
      : agentVerdictTurnText(prefix, id, bare(id), extra.condition, answers);
  return `send ${text}`;
};
const agent = (id: string) => node(id, "agent", { instructions: "Write notes.md." });

function turnHarness(
  turns: Emitted[][],
  turnTimeoutMs = 1000,
  waiter = new FakeWaiter([]),
  files = new FakeFileSystem(),
) {
  const events = new FakeEventSource();
  const calls: string[] = [];
  const lines: string[] = [];
  let sent = 0;
  const deps: TestDeps = {
    store: new FakeStore(),
    prompts: {
      interrupt: async () => undefined,
      sendPrompt: async (text) => {
        calls.push(`send ${text}`);
        for (const event of turns[sent++] ?? []) {
          if (event.kind === "AgentDone") {
            events.publish({
              kind: "PostToolUse",
              sessionId,
              payload: agentDonePayload(event.nodeId, event.agentType, event.reply),
            });
            continue;
          }
          events.publish({
            kind: event.kind,
            sessionId,
            payload: {
              ...(event.kind === "StopFailure" ? { error: event.error } : {}),
              ...(event.reply === undefined ? {} : { last_assistant_message: event.reply }),
            },
          });
        }
      },
    },
    session: {
      ensureStarted: async () => {
        calls.push("start");
      },
    },
    events,
    waiter,
    files,
    onChange: (line) => lines.push(line),
    cwd,
    sessionId,
    turnTimeoutMs,
  };
  return { deps, calls, lines };
}

describe("Runner", () => {
  it("sends each of three agents exactly once, in manifest order", async () => {
    const { deps, calls } = harness();

    const result = await runOn(deps, manifest(agent("a"), agent("b"), agent("c")));

    expect(result.outcome).toBe("done");
    expect(calls.filter((call) => call.startsWith("send"))).toEqual([
      turnOf("a"),
      turnOf("b"),
      turnOf("c"),
    ]);
    expect(result.states).toEqual({ a: "done", b: "done", c: "done" });
  });

  it("arms the turn wait before sending, so a Stop during the send is not missed", async () => {
    const { deps } = harness({ stop: "during-send" });

    const result = await runOn(deps, manifest(agent("a")));

    expect(result.outcome).toBe("done");
    expect(result.states).toEqual({ a: "done" });
  });

  it("fails an agent whose turn never ends and sends nothing after it", async () => {
    const { deps, calls, lines } = harness({ stop: "never" });

    const result = await runOn({ ...deps, turnTimeoutMs: 20 }, manifest(agent("a"), agent("b")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(result.states).toEqual({ a: "failed", b: "waiting" });
    expect(calls).toEqual(["start", turnOf("a")]);
    expect(lines.at(-1)).toMatch(/^a failed: .*no Stop for session s1 within 20 ms/);
  });

  describe("output nodes", () => {
    const output = (id: string) => node(id, "output", { name: "result", type: "text" });

    it("marks an Output done once the node before it finishes", async () => {
      const { deps, lines, calls } = harness();

      const result = await runOn(deps, manifest(agent("p"), output("o")));

      expect(result.outcome).toBe("done");
      expect(result.states).toEqual({ p: "done", o: "done" });
      expect(lines).toEqual(["p started", "p done", "o done"]);
      expect(calls.filter((call) => call.startsWith("send"))).toEqual([turnOf("p")]);
    });

    it("leaves an Output waiting when the run fails before it", async () => {
      const { deps } = turnHarness([[stopped]]);

      const result = await runOn(deps, manifest(agent("s"), output("o")));

      expect(result.states).toEqual({ s: "failed", o: "waiting" });
    });

    it("does not mark an Output that is already done again on resume", async () => {
      const { deps, lines } = harness();
      const m = manifest(output("o"));
      const { id } = deps.store.createRun(newRun(m));
      deps.store.append(id, "o", { kind: "running" });
      deps.store.append(id, "o", { kind: "done" });

      const result = await new Runner({ ...deps, runId: id }).run(m);

      expect(result.states).toEqual({ o: "done" });
      expect(deps.store.events(id)).toHaveLength(2);
      expect(lines).toEqual([]);
    });
  });

  describe("a turn that fails", () => {
    it.each([{ name: "agent", first: agent("n1"), text: agentTurnText(prefix, "n1", bare("n1")) }])(
      "fails the $name node with the session's message and sends nothing after it",
      async ({ first, text }) => {
        const { deps, calls, lines } = turnHarness([[failedTurn], [stopped]], 60_000);

        const result = await runOn(deps, manifest(first, agent("p2")));

        expect(result).toMatchObject({ outcome: "failed", failedNode: "n1" });
        expect(result.states).toEqual({ n1: "failed", p2: "waiting" });
        expect(calls).toEqual(["start", `send ${text}`]);
        expect(lines).toEqual(["n1 started", `n1 failed: ${notLoggedIn}`]);
        expect(deps.store.events(deps.store.runs[0]?.id ?? "").at(-1)).toMatchObject({
          nodeId: "n1",
          kind: "failed",
          payload: { message: `n1 failed: ${notLoggedIn}` },
        });
      },
      2000,
    );
  });

  describe("agent nodes", () => {
    const a1Type = `${prefix}:a1`;

    it("is done when its finished Agent call and then Stop arrive during the send", async () => {
      const { deps, calls, lines } = turnHarness([[agentDone("a1"), stopped]]);

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toEqual({ outcome: "done", states: { a1: "done" }, decisions: [] });
      expect(calls).toEqual(["start", `send ${agentTurnText(prefix, "a1", bare("a1"))}`]);
      expect(lines).toEqual(["a1 started", "a1 done"]);
    });

    it("names a file once in the turn of a writer another node is given it by", async () => {
      const { deps, calls } = turnHarness([[agentDone("a1"), stopped]]);
      const writer = node("a1", "agent", { instructions: "Write notes.md.", writes: ["notes.md"] });
      const reader = node("p2", "agent", { instructions: "Read notes.md.", given: ["notes.md"] });
      const handoff: RunnableManifest = {
        hash,
        prefix,
        nodes: [writer, reader],
        wires: [
          { kind: "then", from: { node: "a1", port: "out" }, to: { node: "p2", port: "in" } },
        ],
      };

      await runOn(deps, handoff);

      expect(calls[1]).toBe(
        `send ${agentTurnText(prefix, "a1", { id: "a1", given: [], writes: ["notes.md"] })}`,
      );
    });

    it("fails when the turn ends with no finished Agent call and sends nothing after it", async () => {
      const { deps, calls, lines } = turnHarness([[stopped], [stopped]]);

      const result = await runOn(deps, manifest(agent("a1"), agent("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(result.states).toEqual({ a1: "failed", p2: "waiting" });
      expect(calls).toEqual(["start", `send ${agentTurnText(prefix, "a1", bare("a1"))}`]);
      expect(lines).toEqual(["a1 started", "a1 failed: no finished Agent call for a1"]);
    });

    it("is not done on a finished Agent call alone; the turn times out", async () => {
      const { deps, lines } = turnHarness([[agentDone("a1")]], 20);

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toMatch(/^a1 failed: .*no Stop for session s1 within 20 ms/);
    });

    it.each([
      { name: "another node's call of the same type", done: agentDone("other", a1Type) },
      { name: "a call with no node marker", done: agentDone(undefined, a1Type) },
    ])("fails when only $name finishes before Stop", async ({ done }) => {
      const { deps, lines } = turnHarness([[done, stopped]]);

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toBe("a1 failed: no finished Agent call for a1");
    });

    it("fails when its finished Agent call arrives only after Stop", async () => {
      const { deps, lines } = turnHarness([[stopped, agentDone("a1")]]);

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toBe("a1 failed: no finished Agent call for a1");
    });

    it("keeps recording its finished Agent call past a Stop stamped before its send", async () => {
      const { deps, lines } = turnHarness([]);
      const events = deps.events as FakeEventSource;
      deps.now = () => 2;
      deps.prompts = {
        interrupt: async () => undefined,
        sendPrompt: async () => {
          events.publish({ kind: "Stop", sessionId, payload: { flowdeck_hook_at: 1 } });
          events.publish({ kind: "PostToolUse", sessionId, payload: agentDonePayload("a1") });
          events.publish({
            kind: "Stop",
            sessionId,
            payload: { flowdeck_hook_at: 3, last_assistant_message: "ok" },
          });
        },
      };

      const result = await runOn(deps, manifest(agent("a1")));

      expect(lines).toEqual(["a1 started", "a1 done"]);
      expect(result).toEqual({ outcome: "done", states: { a1: "done" }, decisions: [] });
      expect(deps.store.events(deps.store.runs[0]?.id ?? "").at(-1)).toMatchObject({
        nodeId: "a1",
        kind: "done",
        payload: { stopMessage: "ok" },
      });
    });

    it("ignores a finished Agent call made from inside a subagent", async () => {
      const { deps, lines } = turnHarness([]);
      const events = deps.events as FakeEventSource;
      deps.prompts = {
        interrupt: async () => undefined,
        sendPrompt: async () => {
          events.publish({
            kind: "PostToolUse",
            sessionId,
            payload: { ...agentDonePayload("a1"), agent_id: "a2acfd3c49ca63d33" },
          });
          events.publish({ kind: "Stop", sessionId, payload: { last_assistant_message: "ok" } });
        },
      };

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toBe("a1 failed: no finished Agent call for a1");
    });

    it("does not carry a finished Agent call seen in one agent's turn into the next", async () => {
      const { deps, lines } = turnHarness([
        [agentDone("a1"), agentDone("a2"), stopped],
        [agentDone("a1"), stopped],
      ]);

      const result = await runOn(deps, manifest(agent("a1"), agent("a2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a2" });
      expect(result.states).toEqual({ a1: "done", a2: "failed" });
      expect(lines).toEqual([
        "a1 started",
        "a1 done",
        "a2 started",
        "a2 failed: no finished Agent call for a2",
      ]);
    });

    it("runs three Agents in order, one turn each, starting Claude once", async () => {
      const { deps, calls, lines } = turnHarness([
        [agentDone("p1"), stopped],
        [agentDone("a1"), stopped],
        [agentDone("p2"), stopped],
      ]);

      const result = await runOn(deps, manifest(agent("p1"), agent("a1"), agent("p2")));

      expect(result.outcome).toBe("done");
      expect(calls).toEqual([
        "start",
        turnOf("p1"),
        `send ${agentTurnText(prefix, "a1", bare("a1"))}`,
        turnOf("p2"),
      ]);
      expect(lines).toEqual([
        "p1 started",
        "p1 done",
        "a1 started",
        "a1 done",
        "p2 started",
        "p2 done",
      ]);
    });

    it("starts Claude once, before the send, for an agent-only manifest", async () => {
      const { deps, calls } = turnHarness([[agentDone("a1"), stopped]]);

      await runOn(deps, manifest(node("t", "trigger"), agent("a1"), node("o", "output")));

      expect(calls).toEqual(["start", `send ${agentTurnText(prefix, "a1", bare("a1"))}`]);
    });
  });

  describe("human nodes", () => {
    const gate = (id: string, skippable = false) =>
      node(id, "gate", { shown: "Check the plan", skippable });
    const hardstopSettings = {
      condition: "",
      shown: "Check tests",
      locked: true,
      enabled: true,
    };
    const hardstop = (id: string, settings: Record<string, unknown> = {}) =>
      node(id, "hardstop", { ...hardstopSettings, ...settings });
    const ask = (id: string, options = ["red", "blue", "green"]) =>
      node(id, "ask", { question: "Pick a colour", options });
    const approve: WaitReply = { decision: "approve" };
    const answer = (text: string): WaitReply => ({ decision: "answer", answer: text });
    const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));

    it("blocks at a Gate until the waiter answers, then continues on approve", async () => {
      let resolve: (reply: WaitReply) => void = () => undefined;
      const waiter = new FakeWaiter([new Promise<WaitReply>((r) => (resolve = r))]);
      const { deps, calls, lines } = harness({ waiter });

      const running = runOn(deps, manifest(agent("p1"), gate("g1"), agent("p2")));
      await vi.waitFor(() => expect(waiter.calls).toHaveLength(1));

      expect(sends(calls)).toEqual([turnOf("p1")]);
      expect(waiter.calls).toEqual([{ nodeId: "g1", kind: "gate", shown: "Check the plan" }]);
      resolve(approve);
      const result = await running;

      expect(result.outcome).toBe("done");
      expect(sends(calls)).toEqual([turnOf("p1"), turnOf("p2")]);
      expect(lines).toEqual(["p1 started", "p1 done", "g1 approved", "p2 started", "p2 done"]);
      expect(result.decisions).toEqual([{ nodeId: "g1", decision: "approved" }]);
      expect(result.states).toEqual({ p1: "done", g1: "done", p2: "done" });
    });

    it("stops the run at a Gate rejected with a reason", async () => {
      const waiter = new FakeWaiter([{ decision: "reject", reason: "wrong scope" }]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(agent("p1"), gate("g1"), agent("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "g1" });
      expect(result.states).toEqual({ p1: "done", g1: "failed", p2: "waiting" });
      expect(lines.at(-1)).toBe("g1 failed: rejected: wrong scope");
      expect(sends(calls)).toEqual([turnOf("p1")]);
      expect(result.decisions).toEqual([
        { nodeId: "g1", decision: "rejected", reason: "wrong scope" },
      ]);
    });

    it("prints rejected alone for a reject with an empty reason", async () => {
      const waiter = new FakeWaiter([{ decision: "reject", reason: "" }]);
      const { deps, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(agent("p1"), gate("g1"), agent("p2")));

      expect(lines.at(-1)).toBe("g1 failed: rejected");
      expect(result.decisions).toEqual([{ nodeId: "g1", decision: "rejected", reason: "" }]);
    });

    it("skips a skippable Gate under auto without asking", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls, lines } = harness({ waiter, auto: true });

      const result = await runOn(deps, manifest(agent("p1"), gate("g1", true), agent("p2")));

      expect(result.outcome).toBe("done");
      expect(waiter.calls).toEqual([]);
      expect(lines).toEqual(["p1 started", "p1 done", "g1 skipped", "p2 started", "p2 done"]);
      expect(sends(calls)).toContain(turnOf("p2"));
      expect(result.states["g1"]).toBe("skipped");
      expect(result.decisions).toEqual([{ nodeId: "g1", decision: "skipped" }]);
    });

    it("asks at a skippable Gate when auto is off", async () => {
      const waiter = new FakeWaiter([approve]);
      const { deps } = harness({ waiter });

      const result = await runOn(deps, manifest(agent("p1"), gate("g1", true), agent("p2")));

      expect(result.outcome).toBe("done");
      expect(waiter.calls).toHaveLength(1);
    });

    it("asks at a Gate that is not skippable even under auto", async () => {
      const waiter = new FakeWaiter([approve]);
      const { deps, lines } = harness({ waiter, auto: true });

      await runOn(deps, manifest(agent("p1"), gate("g1"), agent("p2")));

      expect(waiter.calls).toHaveLength(1);
      expect(lines).toContain("g1 approved");
    });

    it("asks at a Hard stop under auto and continues on continue", async () => {
      const waiter = new FakeWaiter([{ decision: "continue" }]);
      const { deps, lines } = harness({ waiter, auto: true });

      const result = await runOn(deps, manifest(agent("p1"), hardstop("h1"), agent("p2")));

      expect(waiter.calls).toEqual([
        { nodeId: "h1", kind: "hardstop", shown: "Check tests", condition: "" },
      ]);
      expect(lines).toContain("h1 continued");
      expect(result.outcome).toBe("done");
      expect(result.decisions).toEqual([{ nodeId: "h1", decision: "continued" }]);
    });

    it.each([{ locked: false }, { enabled: false }, { locked: false, enabled: false }])(
      "asks at a Hard stop with %o under auto",
      async (settings) => {
        const waiter = new FakeWaiter([{ decision: "continue" }]);
        const { deps } = harness({ waiter, auto: true });

        await runOn(deps, manifest(agent("p1"), hardstop("h1", settings), agent("p2")));

        expect(waiter.calls).toHaveLength(1);
      },
    );

    describe("a Hard stop with a condition", () => {
      const checking = (id: string) => hardstop(id, { condition: "tests fail" });
      const verdict = (holds: boolean) => `Checked.\n\`\`\`json\n{"done": ${holds}}\n\`\`\``;

      it("asks the model whether the condition holds, and stops to ask you when it does", async () => {
        const waiter = new FakeWaiter([{ decision: "stop", reason: "red" }]);
        const { deps, calls, lines } = harness({ waiter, replies: ["P1", verdict(true)] });

        const result = await runOn(deps, manifest(agent("p1"), checking("h1"), agent("p2")));

        expect(sends(calls)).toEqual([turnOf("p1"), `send ${hardstopCheckTurn("tests fail")}`]);
        expect(hardstopCheckTurn("tests fail")).toContain(verdictRequest("tests fail"));
        expect(waiter.calls).toEqual([
          { nodeId: "h1", kind: "hardstop", shown: "Check tests", condition: "tests fail" },
        ]);
        expect(result).toMatchObject({ outcome: "failed", failedNode: "h1" });
        expect(lines.at(-1)).toBe("h1 failed: stopped: red");
      });

      it("goes on without asking when the condition does not hold", async () => {
        const waiter = new FakeWaiter([]);
        const { deps, calls, lines } = harness({ waiter, replies: ["P1", verdict(false), "P2"] });

        const result = await runOn(deps, manifest(agent("p1"), checking("h1"), agent("p2")));

        expect(result.outcome).toBe("done");
        expect(waiter.calls).toEqual([]);
        expect(result.states).toEqual({ p1: "done", h1: "done", p2: "done" });
        expect(lines).toContain("h1 condition not met");
        expect(sends(calls).at(-1)).toBe(turnOf("p2"));
      });

      it("checks and stops under auto too", async () => {
        const waiter = new FakeWaiter([{ decision: "continue" }]);
        const { deps } = harness({ waiter, auto: true, replies: [verdict(true), "P2"] });

        const result = await runOn(deps, manifest(checking("h1"), agent("p2")));

        expect(waiter.calls).toHaveLength(1);
        expect(result.decisions).toEqual([{ nodeId: "h1", decision: "continued" }]);
      });

      it.each([
        ["continue", "done", "h1 answered: continue"],
        ["stop", "failed", "h1 failed: stopped: no readable verdict"],
      ] as const)(
        "asks you when the verdict is unreadable, and %s does what it says",
        async (answer, state, line) => {
          const waiter = new FakeWaiter([{ decision: "answer", answer }]);
          const { deps, lines } = harness({ waiter, replies: ["no idea", "P2"] });

          const result = await runOn(deps, manifest(checking("h1"), agent("p2")));

          expect(waiter.calls).toEqual([
            {
              nodeId: "h1",
              kind: "ask",
              question: "The hard stop got no readable verdict (no json block). Stop the run here?",
              options: ["stop", "continue"],
            },
          ]);
          expect(result.states["h1"]).toBe(state);
          expect(lines).toContain(line);
          expect(result.decisions).toEqual([{ nodeId: "h1", decision: "answered", answer }]);
        },
      );

      it("reuses an answer to an unreadable verdict on resume, without checking again", async () => {
        const waiter = new FakeWaiter([]);
        const { deps, calls } = harness({ waiter, replies: ["P2"] });
        const m = manifest(checking("h1"), agent("p2"));
        const { id } = deps.store.createRun(newRun(m));
        const decision = { nodeId: "h1", decision: "answered", answer: "continue" } as const;
        for (const event of [
          { kind: "running" },
          { kind: "needs-you" },
          { kind: "answered", payload: decision },
        ] as RunEvent[]) {
          deps.store.append(id, "h1", event);
        }

        const result = await new Runner({ ...deps, runId: id }).run(m, {
          actions: { h1: { kind: "reuse", decision } },
        });

        expect(result.outcome).toBe("done");
        expect(waiter.calls).toEqual([]);
        expect(sends(calls)).toEqual([turnOf("p2")]);
      });

      it("sends no check for a Hard stop with no condition, and asks you", async () => {
        const waiter = new FakeWaiter([{ decision: "continue" }]);
        const { deps, calls } = harness({ waiter });

        await runOn(deps, manifest(hardstop("h1"), agent("p2")));

        expect(sends(calls)).toEqual([turnOf("p2")]);
        expect(waiter.calls).toHaveLength(1);
      });
    });

    it("stops the run at a Hard stop stopped with a reason", async () => {
      const waiter = new FakeWaiter([{ decision: "stop", reason: "tests fail" }]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(agent("p1"), hardstop("h1"), agent("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "h1" });
      expect(lines.at(-1)).toBe("h1 failed: stopped: tests fail");
      expect(sends(calls)).toEqual([turnOf("p1")]);
      expect(result.decisions).toEqual([
        { nodeId: "h1", decision: "stopped", reason: "tests fail" },
      ]);
    });

    it.each([
      ["gate", gate("x")],
      ["hardstop", hardstop("x")],
      ["ask", ask("x")],
    ] as const)("fails a %s whose input closed", async (_type, human) => {
      const waiter = new FakeWaiter([{ decision: "closed" }]);
      const { deps, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(human, agent("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "x" });
      expect(lines).toEqual(["x failed: no answer: input closed"]);
      expect(result.decisions).toEqual([]);
    });

    it("fails a Gate with the waiter's error when the waiter throws", async () => {
      const { deps, lines } = harness({ waiter: new FakeWaiter([]) });

      const result = await runOn(deps, manifest(agent("p1"), gate("g1"), agent("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "g1" });
      expect(lines.at(-1)).toBe("g1 failed: FakeWaiter: no scripted reply for g1");
    });

    it("attaches an Ask's answer to the next Agent", async () => {
      const waiter = new FakeWaiter([answer("blue")]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(ask("q1"), agent("p1")));

      expect(lines).toEqual(["q1 answered: blue", "p1 started", "p1 done"]);
      expect(sends(calls)).toEqual([turnOf("p1", { answers: ["blue"] })]);
      expect(result.decisions).toEqual([{ nodeId: "q1", decision: "answered", answer: "blue" }]);
      expect(waiter.calls).toEqual([
        { nodeId: "q1", kind: "ask", question: "Pick a colour", options: ["red", "blue", "green"] },
      ]);
    });

    it("keeps an answer past a Hard stop's check turn and a Gate for the next Agent", async () => {
      const waiter = new FakeWaiter([answer("blue"), approve]);
      const notMet = 'Checked.\n```json\n{"done": false}\n```';
      const { deps, calls } = harness({ waiter, replies: [notMet] });
      const checking = hardstop("h1", { condition: "tests fail" });

      await runOn(deps, manifest(ask("q1"), checking, gate("g1"), agent("p1")));

      expect(sends(calls)).toEqual([
        `send ${hardstopCheckTurn("tests fail")}`,
        turnOf("p1", { answers: ["blue"] }),
      ]);
    });

    it("uses an answer once", async () => {
      const { deps, calls } = harness({ waiter: new FakeWaiter([answer("blue")]) });

      await runOn(deps, manifest(ask("q1"), agent("p1"), agent("p2")));

      expect(sends(calls)).toEqual([turnOf("p1", { answers: ["blue"] }), turnOf("p2")]);
    });

    it("joins two answers in order on the next Agent", async () => {
      const waiter = new FakeWaiter([answer("red"), answer("blue")]);
      const { deps, calls } = harness({ waiter });

      await runOn(deps, manifest(ask("q1"), ask("q2"), agent("p1")));

      expect(sends(calls)).toEqual([turnOf("p1", { answers: ["red", "blue"] })]);
    });

    it("puts an answer inside the prompt the next Agent's subagent receives", async () => {
      const waiter = new FakeWaiter([answer("blue")]);
      const { deps, calls, lines } = turnHarness([[agentDone("a1"), stopped]], 1000, waiter);

      await runOn(deps, manifest(ask("q1"), agent("a1")));

      expect(sends(calls)).toEqual([
        `send Use the Agent tool with subagent_type "${prefix}:a1" and the prompt "NODE a1\\nThe user answered: blue.\\nGo". Then reply DONE.`,
      ]);
      expect(lines).toContain("a1 done");
    });

    it("sends nothing and starts nothing for an Ask with nothing after it", async () => {
      const { deps, calls, lines } = harness({ waiter: new FakeWaiter([answer("blue")]) });

      const result = await runOn(deps, manifest(ask("q1")));

      expect(result.outcome).toBe("done");
      expect(calls).toEqual([]);
      expect(lines).toEqual(["q1 answered: blue"]);
    });
  });

  describe("loop nodes", () => {
    const fence = "```";
    const verdict = (done: boolean) => `ok\n${fence}json\n{"done": ${done}}\n${fence}`;
    const condition = "no issues left";
    const loop = (id: string, settings: Record<string, unknown> = {}) =>
      node(id, "loop", { condition, cap: 3, onCap: "fail", ...settings });
    const inLoop = (child: ManifestNode, parent = "l1"): ManifestNode => ({ ...child, parent });
    const reviewFix = (settings: Record<string, unknown> = {}) =>
      manifest(loop("l1", settings), inLoop(agent("r1")), inLoop(agent("f1")), agent("p9"));
    const replies = (...verdicts: boolean[]) =>
      verdicts.flatMap((done) => ["review", verdict(done)]);
    const answer = (text: string): WaitReply => ({ decision: "answer", answer: text });
    const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
    const rounds = (lines: string[]) => lines.filter((line) => /^l1 round \d+$/.test(line));
    const sendR1 = turnOf("r1");
    const sendF1 = turnOf("f1", { condition });
    const sendP9 = turnOf("p9");

    it("stops after exactly cap rounds that are never done and fails on cap fail", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls, lines } = harness({ waiter, replies: replies(false, false, false) });

      const result = await runOn(deps, reviewFix());

      expect(sends(calls)).toEqual([sendR1, sendF1, sendR1, sendF1, sendR1, sendF1]);
      expect(lines).toEqual([
        ...[1, 2, 3].flatMap((round) => [
          `l1 round ${round}`,
          "r1 started",
          "r1 done",
          "f1 started",
          "f1 done",
        ]),
        "l1 failed: cap reached after 3 rounds",
      ]);
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
      expect(result.states["l1"]).toBe("failed");
      expect(waiter.calls).toEqual([]);
    });

    it("asks once at the cap on cap ask and goes on after the loop on continue", async () => {
      const waiter = new FakeWaiter([answer("continue")]);
      const { deps, calls, lines } = harness({ waiter, replies: replies(false, false, false) });

      const result = await runOn(deps, reviewFix({ onCap: "ask" }));

      expect(rounds(lines)).toEqual(["l1 round 1", "l1 round 2", "l1 round 3"]);
      expect(waiter.calls).toEqual([capRequest("l1", 3)]);
      expect(sends(calls)).toEqual([sendR1, sendF1, sendR1, sendF1, sendR1, sendF1, sendP9]);
      expect(lines.slice(-4)).toEqual([
        "l1 answered: continue",
        "l1 done",
        "p9 started",
        "p9 done",
      ]);
      expect(result.outcome).toBe("done");
      expect(result.decisions).toEqual([
        { nodeId: "l1", decision: "answered", answer: "continue" },
      ]);
    });

    it("fails at the cap on cap ask answered fail", async () => {
      const waiter = new FakeWaiter([answer("fail")]);
      const { deps, calls, lines } = harness({ waiter, replies: replies(false, false, false) });

      const result = await runOn(deps, reviewFix({ onCap: "ask" }));

      expect(lines.at(-1)).toBe("l1 failed: cap reached after 3 rounds");
      expect(sends(calls)).not.toContain(sendP9);
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
    });

    it("asks at the cap on cap ask even under auto", async () => {
      const waiter = new FakeWaiter([answer("continue")]);
      const { deps } = harness({ waiter, auto: true, replies: replies(false, false, false) });

      await runOn(deps, reviewFix({ onCap: "ask" }));

      expect(waiter.calls).toHaveLength(1);
    });

    it("runs exactly two rounds when the verdict is done in round 2", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls, lines } = harness({ waiter, replies: replies(false, true) });

      const result = await runOn(deps, reviewFix());

      expect(sends(calls)).toEqual([sendR1, sendF1, sendR1, sendF1, sendP9]);
      expect(rounds(lines)).toEqual(["l1 round 1", "l1 round 2"]);
      expect(lines.slice(-3)).toEqual(["l1 done", "p9 started", "p9 done"]);
      expect(waiter.calls).toEqual([]);
      expect(result.outcome).toBe("done");
    });

    it("leaves the loop and its body done after the last round", async () => {
      const { deps } = harness({ replies: replies(false, true) });

      const result = await runOn(deps, reviewFix());

      expect(result.states).toMatchObject({ l1: "done", r1: "done", f1: "done", p9: "done" });
    });

    it("exits normally when the verdict is done on the last round", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, lines } = harness({ waiter, replies: replies(false, false, true) });

      const result = await runOn(deps, reviewFix({ onCap: "ask" }));

      expect(rounds(lines)).toHaveLength(3);
      expect(waiter.calls).toEqual([]);
      expect(lines).toContain("l1 done");
      expect(result.outcome).toBe("done");
    });

    it("runs one round when the verdict is done in round 1", async () => {
      const { deps, calls, lines } = harness({ replies: replies(true) });

      await runOn(deps, reviewFix());

      expect(rounds(lines)).toEqual(["l1 round 1"]);
      expect(sends(calls)).toEqual([sendR1, sendF1, sendP9]);
    });

    it("pauses on a reply with no verdict until the answer, running nothing more", async () => {
      let resolve: (reply: WaitReply) => void = () => undefined;
      const waiter = new FakeWaiter([new Promise<WaitReply>((r) => (resolve = r))]);
      const { deps, calls, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      const running = runOn(deps, reviewFix());
      await vi.waitFor(() => expect(waiter.calls).toHaveLength(1));

      expect(sends(calls)).toEqual([sendR1, sendF1]);
      expect(waiter.calls).toEqual([malformedRequest("l1", 1, "no json block")]);
      expect(lines).not.toContain("l1 done");
      expect(lines).not.toContain("l1 round 2");
      resolve(answer("done"));
      const result = await running;

      expect(sends(calls)).toEqual([sendR1, sendF1, sendP9]);
      expect(lines.slice(-5)).toEqual([
        "f1 done",
        "l1 answered: done",
        "l1 done",
        "p9 started",
        "p9 done",
      ]);
      expect(result.decisions).toEqual([{ nodeId: "l1", decision: "answered", answer: "done" }]);
    });

    it("asks with the reason no reply when the verdict turn's Stop has no message", async () => {
      const waiter = new FakeWaiter([answer("done")]);
      const { deps } = harness({ waiter, replies: ["review"] });

      await runOn(deps, reviewFix());

      expect(waiter.calls).toEqual([malformedRequest("l1", 1, "no reply")]);
    });

    it("runs another round on again", async () => {
      const waiter = new FakeWaiter([answer("again")]);
      const { deps, calls, lines } = harness({
        waiter,
        replies: ["review", "no verdict here", "review", verdict(true)],
      });

      const result = await runOn(deps, reviewFix());

      expect(rounds(lines)).toEqual(["l1 round 1", "l1 round 2"]);
      expect(sends(calls)).toEqual([sendR1, sendF1, sendR1, sendF1, sendP9]);
      expect(lines).toContain("l1 done");
      expect(result.outcome).toBe("done");
    });

    it("counts again toward the cap", async () => {
      const waiter = new FakeWaiter([answer("again")]);
      const { deps, calls, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      await runOn(deps, reviewFix({ cap: 1 }));

      expect(rounds(lines)).toEqual(["l1 round 1"]);
      expect(sends(calls)).toEqual([sendR1, sendF1]);
      expect(lines.at(-1)).toBe("l1 failed: cap reached after 1 rounds");
    });

    it("fails the loop on fail after a reply with no verdict", async () => {
      const waiter = new FakeWaiter([answer("fail")]);
      const { deps, calls, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      const result = await runOn(deps, reviewFix());

      expect(lines.at(-1)).toBe("l1 failed: no verdict in round 1");
      expect(sends(calls)).not.toContain(sendP9);
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
    });

    it("asks after a reply with no verdict even under auto", async () => {
      const waiter = new FakeWaiter([answer("done")]);
      const { deps, lines } = harness({
        waiter,
        auto: true,
        replies: ["review", "no verdict here"],
      });

      await runOn(deps, reviewFix());

      expect(waiter.calls).toHaveLength(1);
      expect(lines).toContain("l1 done");
    });

    it("fails the loop when the input closes while it asks", async () => {
      const waiter = new FakeWaiter([{ decision: "closed" }]);
      const { deps, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      const result = await runOn(deps, reviewFix());

      expect(lines.at(-1)).toBe("l1 failed: no answer: input closed");
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
    });

    it("fails the loop with the waiter's error when the waiter throws", async () => {
      const { deps, calls, lines } = harness({
        waiter: new FakeWaiter([]),
        replies: ["review", "no verdict here"],
      });

      const result = await runOn(deps, reviewFix());

      expect(lines.at(-1)).toBe("l1 failed: FakeWaiter: no scripted reply for l1");
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
      expect(result.states["l1"]).toBe("failed");
      expect(sends(calls)).not.toContain(sendP9);
    });

    it("sends the verdict request on the verdict turn only", async () => {
      const { deps, calls } = harness({ replies: replies(true) });

      await runOn(deps, reviewFix());

      expect(sends(calls)).toEqual([turnOf("r1"), turnOf("f1", { condition }), turnOf("p9")]);
      expect(sends(calls)[1]).toContain(`Condition: ${condition}`);
    });

    it("puts the verdict request after an Ask's answer on the verdict turn", async () => {
      const waiter = new FakeWaiter([answer("blue")]);
      const { deps, calls } = harness({ waiter, replies: [verdict(true)] });
      const ask = node("q1", "ask", { question: "Pick a colour", options: ["red", "blue"] });

      await runOn(deps, manifest(loop("l1"), inLoop(ask), inLoop(agent("f1")), agent("p9")));

      expect(sends(calls)[0]).toBe(turnOf("f1", { answers: ["blue"], condition }));
    });

    it("makes the last Agent the verdict turn even with a Gate after it", async () => {
      const { deps, calls, lines } = harness({
        auto: true,
        replies: [verdict(false), verdict(true)],
      });
      const gate = node("g1", "gate", { shown: "Check the plan", skippable: true });

      const result = await runOn(
        deps,
        manifest(loop("l1"), inLoop(agent("f1")), inLoop(gate), agent("p9")),
      );

      expect(result.outcome).toBe("done");
      expect(sends(calls)).toEqual([sendF1, sendF1, sendP9]);
      expect(lines).toEqual([
        ...[1, 2].flatMap((round) => [`l1 round ${round}`, "f1 started", "f1 done", "g1 skipped"]),
        "l1 done",
        "p9 started",
        "p9 done",
      ]);
    });

    it("asks an Agent verdict turn for the verdict and reads it from the main Stop", async () => {
      const { deps, calls, lines } = turnHarness([
        [
          { kind: "AgentDone", nodeId: "a1", agentType: `${prefix}:a1`, reply: verdict(true) },
          { kind: "Stop", reply: verdict(false) },
        ],
      ]);

      await runOn(deps, manifest(loop("l1", { cap: 1 }), inLoop(agent("a1"))));

      expect(calls).toEqual([
        "start",
        `send ${agentVerdictTurnText(prefix, "a1", bare("a1"), condition)}`,
      ]);
      expect(calls[1]).not.toContain("Then reply DONE.");
      expect(calls[1]?.endsWith(`Condition: ${condition}`)).toBe(true);
      expect(lines.at(-1)).toBe("l1 failed: cap reached after 1 rounds");
    });

    it("runs a body Gate skipped under auto again in every round", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, lines } = harness({
        waiter,
        auto: true,
        replies: [verdict(false), verdict(true)],
      });
      const gate = node("g1", "gate", { shown: "Check the plan", skippable: true });

      const result = await runOn(
        deps,
        manifest(loop("l1"), inLoop(gate), inLoop(agent("f1")), agent("p9")),
      );

      expect(lines.filter((line) => line === "g1 skipped")).toHaveLength(2);
      expect(rounds(lines)).toHaveLength(2);
      expect(result.outcome).toBe("done");
    });

    it("fails the run at a failing body Agent", async () => {
      const { deps, calls, lines } = turnHarness([[stopped]]);

      const result = await runOn(deps, manifest(loop("l1"), inLoop(agent("f1")), agent("p9")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "f1" });
      expect(result.states).toMatchObject({ l1: "failed", f1: "failed", p9: "waiting" });
      expect(lines).not.toContain("l1 round 2");
      expect(lines.at(-1)).toBe("f1 failed: no finished Agent call for f1");
      expect(sends(calls)).not.toContain(sendP9);
    });

    describe("structure check", () => {
      const refuses = async (nodes: ManifestNode[]) => {
        const { deps, calls, lines } = harness();
        const error = await runOn(deps, manifest(...nodes)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(StructureError);
        expect(calls).toEqual([]);
        expect(lines).toEqual([]);
        return error as StructureError;
      };

      it.each([
        ["no body", [loop("l1"), agent("p9")]],
        ["a Gate-only body", [loop("l1"), inLoop(node("g1", "gate")), agent("p9")]],
      ])("refuses a loop with %s", async (_name, nodes) => {
        const error = await refuses(nodes);

        expect(error.message).toBe("cannot run this build: l1 (loop) has no agent in its body");
        expect(error.problems).toEqual(["l1 (loop) has no agent in its body"]);
      });

      it("refuses a loop inside a loop", async () => {
        const error = await refuses([
          loop("l1"),
          inLoop(agent("p1")),
          inLoop(loop("l2")),
          inLoop(agent("p2"), "l2"),
        ]);

        expect(error.problems).toContain("l2 (loop) is inside loop l1");
      });

      it("refuses a node whose parent is not a loop", async () => {
        const error = await refuses([agent("s1"), inLoop(agent("p1"), "s1")]);

        expect(error.problems).toEqual([
          "p1 (agent) has parent s1, which is not a loop or foreach",
        ]);
      });

      it("lists every problem in one error, in manifest order", async () => {
        const error = await refuses([loop("l1"), agent("s1"), inLoop(agent("p1"), "s1")]);

        expect(error.problems).toEqual([
          "l1 (loop) has no agent in its body",
          "p1 (agent) has parent s1, which is not a loop or foreach",
        ]);
        expect(error.message).toBe(`cannot run this build: ${error.problems.join("; ")}`);
      });

      it("finds no problem in a loop with an Agent in its body", () => {
        expect(structureProblems(reviewFix().nodes)).toEqual([]);
      });

      it("finds no problem in a For each with a Gate before the Agent in its body", () => {
        const nodes = [forEach("e1"), inEach(node("g1", "gate")), inEach(agent("p1")), agent("p9")];

        expect(structureProblems(nodes)).toEqual([]);
      });

      it.each([
        [
          "a For each inside a loop",
          [loop("l1"), inLoop(agent("p0")), inLoop(forEach("e1")), inEach(agent("p1"))],
          "e1 (foreach) is inside loop l1",
        ],
        [
          "a For each inside a For each",
          [forEach("e1"), inEach(agent("p1")), inEach(forEach("e2")), inEach(agent("p2"), "e2")],
          "e2 (foreach) is inside foreach e1",
        ],
        [
          "a loop inside a For each",
          [forEach("e1"), inEach(agent("p1")), inEach(loop("l1")), inLoop(agent("p2"))],
          "l1 (loop) is inside foreach e1",
        ],
      ])("refuses %s", async (_name, nodes, problem) => {
        const error = await refuses(nodes);

        expect(error.problems).toContain(problem);
      });

      it("finds no problem in a For each whose body starts with an Agent", () => {
        const nodes = [forEach("e1"), inEach(agent("a1")), inEach(agent("p1"))];

        expect(structureProblems(nodes)).toEqual([]);
      });

      it.each([
        ["no body", [forEach("e1"), agent("p9")]],
        ["a Gate-only body", [forEach("e1"), inEach(node("g1", "gate")), agent("p9")]],
      ])("refuses a For each with %s", async (_name, nodes) => {
        const error = await refuses(nodes);

        expect(error.problems).toEqual(["e1 (foreach) has no agent in its body"]);
      });
    });
  });

  describe("for each nodes", () => {
    const plan = `${cwd}/plan.md`;
    const units = "# Plan\n\nThe units to build.\n\n- alpha\n- bravo\n- charlie\n";
    const eachUnit = manifest(
      forEach("e1"),
      inEach(agent("p1")),
      inEach(agent("p2")),
      agent("after"),
    );
    const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
    const sendP1 = (item: string) => turnOf("p1", { item });
    const sendP2 = turnOf("p2");
    const sendAfter = turnOf("after");
    const allRounds = [
      sendP1("alpha"),
      sendP2,
      sendP1("bravo"),
      sendP2,
      sendP1("charlie"),
      sendP2,
      sendAfter,
    ];
    const runIdOf = (store: FakeStore) => store.runs[0]?.id ?? "";
    const eventsOf = (store: FakeStore, nodeId: string) =>
      store.events(runIdOf(store)).filter((event) => event.nodeId === nodeId);
    const kindsOf = (store: FakeStore, nodeId: string) =>
      eventsOf(store, nodeId).map((event) => event.kind);
    const reads = (files: FakeFileSystem) => files.calls.filter((c) => c.method === "readFile");
    const withPlan = (content = units) => new FakeFileSystem({ [plan]: content });

    it("runs the body once per unit, in file order, then goes on", async () => {
      const { deps, calls } = harness({ files: withPlan() });

      const result = await runOn(deps, eachUnit);

      expect(sends(calls)).toEqual(allRounds);
      expect(result.outcome).toBe("done");
      expect(result.states).toEqual({ e1: "done", p1: "done", p2: "done", after: "done" });
    });

    it("skips the body and goes on when the file holds no list", async () => {
      const { deps, calls } = harness({ files: withPlan("# Plan\n") });

      const result = await runOn(deps, eachUnit);

      expect(sends(calls)).toEqual([sendAfter]);
      expect(result.outcome).toBe("done");
      expect(result.states).toEqual({ e1: "done", p1: "skipped", p2: "skipped", after: "done" });
    });

    it("fails the For each, naming the file, when the file is missing", async () => {
      const { deps, calls, lines } = harness();
      const message = `e1 failed: could not read plan.md: No such file: ${plan}`;

      const result = await runOn(deps, eachUnit);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "e1" });
      expect(result.states).toMatchObject({ e1: "failed", p1: "waiting", after: "waiting" });
      const failed = eventsOf(deps.store, "e1").filter((event) => event.kind === "failed");
      expect(failed).toEqual([expect.objectContaining({ payload: { message } })]);
      expect(lines.filter((line) => line.startsWith("e1 failed"))).toEqual([message]);
      expect(sends(calls)).toEqual([]);
    });

    it("reads the file once, so a change during round 1 leaves later rounds as listed", async () => {
      const files = withPlan();
      const { deps, calls } = harness({ files });
      const rewriting: TestDeps = {
        ...deps,
        prompts: {
          ...deps.prompts,
          sendPrompt: async (text) => {
            await files.writeFile(plan, "- zulu\n");
            await deps.prompts.sendPrompt(text);
          },
        },
      };

      await runOn(rewriting, eachUnit);

      expect(sends(calls)).toEqual(allRounds);
      expect(reads(files)).toEqual([{ method: "readFile", path: plan }]);
    });

    it("fails the For each at a failing body turn and runs nothing after it", async () => {
      const { deps, calls } = turnHarness(
        [[agentDone("p1"), stopped], [agentDone("p2"), stopped], [stopped]],
        20,
        undefined,
        withPlan(),
      );

      const result = await runOn(deps, eachUnit);

      expect(sends(calls)).toEqual([sendP1("alpha"), sendP2, sendP1("bravo")]);
      expect(result).toMatchObject({ outcome: "failed", failedNode: "p1" });
      expect(result.states).toMatchObject({ e1: "failed", p1: "failed", after: "waiting" });
    });

    it("records the items on round 1 only and resets the body from round 2", async () => {
      const { deps } = harness({ files: withPlan() });

      await runOn(deps, eachUnit);

      const rounds = eventsOf(deps.store, "e1").flatMap((event) =>
        event.kind === "round" ? [event.payload] : [],
      );
      expect(rounds).toEqual([
        { round: 1, items: ["alpha", "bravo", "charlie"] },
        { round: 2 },
        { round: 3 },
      ]);
      const perRound = ["sent", "done", "reset", "sent", "done", "reset", "sent", "done"];
      expect(kindsOf(deps.store, "p1")).toEqual(perRound);
      expect(kindsOf(deps.store, "p2")).toEqual(perRound);
    });

    describe("a body that starts with an Agent", () => {
      const agentFirst = manifest(forEach("e1"), inEach(agent("a1")), inEach(agent("p2")));
      const agentRound = [agentDone("a1"), stopped];
      const agentSend = (item: string) =>
        `send Use the Agent tool with subagent_type "${prefix}:a1" and the prompt ${JSON.stringify(`NODE a1\nGo. This round's item: ${item}`)}. Then reply DONE.`;

      it("hands each round's item to the agent and runs every round to done", async () => {
        const { deps, calls } = turnHarness(
          [agentRound, [agentDone("p2"), stopped], agentRound, [agentDone("p2"), stopped]],
          1000,
          undefined,
          withPlan("- alpha\n- bravo\n"),
        );

        const result = await runOn(deps, agentFirst);

        expect(sends(calls)).toEqual([agentSend("alpha"), sendP2, agentSend("bravo"), sendP2]);
        expect(result).toMatchObject({ outcome: "done" });
        expect(result.states).toEqual({ e1: "done", a1: "done", p2: "done" });
      });

      it("keeps an item with quotes in one quoted prompt", async () => {
        const { deps, calls } = turnHarness(
          [agentRound, [stopped]],
          1000,
          undefined,
          withPlan('- say "hi"\n'),
        );

        await runOn(deps, agentFirst);

        expect(sends(calls)[0]).toBe(
          `send Use the Agent tool with subagent_type "${prefix}:a1" and the prompt "NODE a1\\nGo. This round's item: say \\"hi\\"". Then reply DONE.`,
        );
      });
    });

    describe("resuming", () => {
      const throughRound2: [string, RunEvent][] = [
        ["e1", { kind: "running" }],
        ["e1", { kind: "round", payload: { round: 1, items: ["alpha", "bravo", "charlie"] } }],
        ["p1", { kind: "sent" }],
        ["p1", { kind: "done" }],
        ["p2", { kind: "sent" }],
        ["p2", { kind: "done" }],
        ["e1", { kind: "round", payload: { round: 2 } }],
        ["p1", { kind: "reset" }],
        ["p2", { kind: "reset" }],
      ];
      const resumeAfter = (
        deps: TestDeps,
        entries: [string, RunEvent][],
        actions: ResumeActions,
      ) => {
        const { id } = deps.store.createRun(newRun(eachUnit));
        for (const [nodeId, event] of entries) deps.store.append(id, nodeId, event);
        return new Runner({ ...deps, runId: id }).run(eachUnit, { actions });
      };

      it("goes on from round 2 with the recorded items, without reading the file", async () => {
        const { deps, calls, files } = harness();

        const result = await resumeAfter(deps, throughRound2, {});

        expect(sends(calls)).toEqual(allRounds.slice(2));
        expect(reads(files)).toEqual([]);
        expect(kindsOf(deps.store, "e1").filter((kind) => kind === "running")).toHaveLength(1);
        expect(result.outcome).toBe("done");
      });

      it("resends round 2's first agent with round 2's item", async () => {
        const { deps, calls } = harness();

        await resumeAfter(deps, [...throughRound2, ["p1", { kind: "sent" }]], {
          p1: { kind: "send" },
        });

        expect(sends(calls)[0]).toBe(sendP1("bravo"));
      });
    });
  });

  it("marks a trigger done when the run starts, before anything is sent", async () => {
    const { deps } = harness();
    let triggerAtSend: string | undefined;
    const send = deps.prompts.sendPrompt;
    deps.prompts.sendPrompt = async (text) => {
      triggerAtSend = nodeStatus(
        deps.store.events(deps.store.runs[0]?.id ?? "").filter((e) => e.nodeId === "t"),
      );
      await send(text);
    };

    const result = await runOn(deps, manifest(node("t", "trigger"), agent("p")));

    expect(result.outcome).toBe("done");
    expect(triggerAtSend).toBe("done");
  });

  it("skips a trigger without a line or a call, and marks an output done without a call", async () => {
    const { deps, calls, lines } = harness();

    const result = await runOn(
      deps,
      manifest(node("t", "trigger"), agent("p"), node("o", "output")),
    );

    expect(result.outcome).toBe("done");
    expect(calls).toEqual(["start", turnOf("p")]);
    expect(lines).toEqual(["p started", "p done", "o done"]);
  });

  it("starts Claude once, before the first agent", async () => {
    const { deps, calls } = harness();

    await runOn(deps, manifest(agent("a"), agent("b"), agent("c")));

    expect(calls.filter((call) => call === "start")).toHaveLength(1);
    expect(calls[0]).toBe("start");
  });

  it("fails the agent with the error when sending it rejects", async () => {
    const { deps, lines } = harness({ stop: "never" });
    const failing: TestDeps = {
      ...deps,
      turnTimeoutMs: 20,
      prompts: {
        sendPrompt: () => Promise.reject(new Error("box never emptied")),
        interrupt: async () => undefined,
      },
    };

    const result = await runOn(failing, manifest(agent("a")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(lines).toEqual(["a started", "a failed: box never emptied"]);
  });

  it("fails the agent with the error when Claude cannot start", async () => {
    const { deps, lines } = harness();
    const failing: TestDeps = {
      ...deps,
      session: { ensureStarted: () => Promise.reject(new Error("not ready within 30000 ms")) },
    };

    const result = await runOn(failing, manifest(agent("a"), agent("b")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(result.states).toEqual({ a: "failed", b: "waiting" });
    expect(lines).toEqual(["a started", "a failed: not ready within 30000 ms"]);
  });
});

describe("Runner run state", () => {
  const fence = "```";
  const verdict = (done: boolean) => `ok\n${fence}json\n{"done": ${done}}\n${fence}`;
  const condition = "no issues left";
  const loop = (id: string) => node(id, "loop", { condition, cap: 3, onCap: "fail" });
  const inLoop = (child: ManifestNode, parent = "l1"): ManifestNode => ({ ...child, parent });
  const gate = (id: string) => node(id, "gate", { shown: "Check the plan", skippable: false });
  const ask = (id: string) => node(id, "ask", { question: "Pick a colour", options: ["blue"] });
  const approve: WaitReply = { decision: "approve" };
  const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
  const runIdOf = (store: FakeStore) => store.runs[0]?.id ?? "";
  const eventsOf = (store: FakeStore, nodeId: string) =>
    store.events(runIdOf(store)).filter((event) => event.nodeId === nodeId);
  const kindsOf = (store: FakeStore, nodeId: string) =>
    eventsOf(store, nodeId).map((event) => event.kind);

  it("writes one run and one node entry per node, each folding to done", async () => {
    const { deps } = harness();

    await runOn(deps, manifest(agent("a"), agent("b"), agent("c")));

    expect(deps.store.runs).toHaveLength(1);
    expect(deps.store.nodes).toHaveLength(3);
    for (const id of ["a", "b", "c"]) expect(nodeStatus(eventsOf(deps.store, id))).toBe("done");
  });

  it("marks each Agent sent before its send, and done only after the turn ends", async () => {
    const { deps } = turnHarness([
      [agentDone("p1"), stopped],
      [agentDone("a1"), stopped],
    ]);
    const store = new FakeStore();
    const seenAtSend: string[][] = [];
    const watched: TestDeps = {
      ...deps,
      store,
      prompts: {
        interrupt: async () => undefined,
        sendPrompt: async (text) => {
          seenAtSend.push(
            store.events(runIdOf(store)).map((event) => `${event.nodeId} ${event.kind}`),
          );
          await deps.prompts.sendPrompt(text);
        },
      },
    };

    await runOn(watched, manifest(agent("p1"), agent("a1")));

    expect(seenAtSend).toEqual([["p1 sent"], ["p1 sent", "p1 done", "a1 sent"]]);
    expect(kindsOf(store, "a1")).toEqual(["sent", "done"]);
  });

  it("writes no done for a turn that never ends", async () => {
    const { deps } = harness({ stop: "never" });

    await runOn({ ...deps, turnTimeoutMs: 20 }, manifest(agent("a")));

    expect(kindsOf(deps.store, "a")).toEqual(["sent", "failed"]);
  });

  it("stores an Agent's Stop message on its done event", async () => {
    const { deps } = harness({ replies: ["X"] });

    await runOn(deps, manifest(agent("p1")));

    expect(eventsOf(deps.store, "p1").at(-1)).toMatchObject({
      kind: "done",
      payload: { stopMessage: "X" },
    });
  });

  it("stores a Gate decision and an Ask answer as events and projects the decisions from them", async () => {
    const waiter = new FakeWaiter([approve, { decision: "answer", answer: "blue" }]);
    const { deps } = harness({ waiter });

    const result = await runOn(deps, manifest(gate("g1"), ask("q1"), agent("p1")));

    expect(kindsOf(deps.store, "g1")).toEqual(["needs-you", "decided", "done"]);
    expect(kindsOf(deps.store, "q1")).toEqual(["needs-you", "answered", "done"]);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions).toEqual(decisionsOf(deps.store.events(runIdOf(deps.store))));
  });

  it("writes a round event per round and resets every body node before round 2", async () => {
    const { deps } = harness({ replies: ["review", verdict(false), "review", verdict(true)] });

    await runOn(deps, manifest(loop("l1"), inLoop(agent("r1")), inLoop(agent("f1"))));

    const rounds = eventsOf(deps.store, "l1").flatMap((event) =>
      event.kind === "round" ? [event.payload.round] : [],
    );
    expect(rounds).toEqual([1, 2]);
    expect(kindsOf(deps.store, "r1")).toEqual(["sent", "done", "reset", "sent", "done"]);
    expect(kindsOf(deps.store, "f1")).toEqual(["sent", "done", "reset", "sent", "done"]);
    const order = deps.store.events(runIdOf(deps.store)).map((e) => `${e.nodeId} ${e.kind}`);
    expect(order.indexOf("f1 reset")).toBeLessThan(order.lastIndexOf("r1 sent"));
  });

  describe("steps that write more than one event", () => {
    const batchesOf = (store: FakeStore) => {
      const spy = vi.spyOn(store, "appendAll");
      return () =>
        spy.mock.calls.map(([, entries]) =>
          entries.map(({ nodeId, event }) => `${nodeId} ${event.kind}`),
        );
    };

    it("writes a round with its body resets in one batch", async () => {
      const { deps } = harness({ replies: ["review", verdict(false), "review", verdict(true)] });
      const batches = batchesOf(deps.store);

      await runOn(deps, manifest(loop("l1"), inLoop(agent("r1")), inLoop(agent("f1"))));

      expect(batches()).toContainEqual(["l1 round", "r1 reset", "f1 reset"]);
    });

    it("writes the loop's running move after an 'again' answer in the same batch as the round", async () => {
      const waiter = new FakeWaiter([{ decision: "answer", answer: "again" }]);
      const { deps } = harness({ waiter, replies: ["no verdict here", verdict(true)] });
      const batches = batchesOf(deps.store);

      await runOn(deps, manifest(loop("l1"), inLoop(agent("r1"))));

      expect(batches()).toContainEqual(["l1 running", "l1 round", "r1 reset"]);
    });

    it("writes an auto-skipped Gate's decision and its skip in one batch", async () => {
      const { deps } = harness({ auto: true });
      const batches = batchesOf(deps.store);

      await runOn(deps, manifest(node("g1", "gate", { shown: "Check", skippable: true })));

      expect(batches()).toContainEqual(["g1 decided", "g1 skipped"]);
    });
  });

  describe("resuming a killed run", () => {
    function seeded(deps: TestDeps, m: RunnableManifest, entries: [string, RunEvent][]) {
      const { id } = deps.store.createRun(newRun(m));
      for (const [nodeId, event] of entries) deps.store.append(id, nodeId, event);
      return id;
    }
    const resume = (deps: TestDeps, m: RunnableManifest, runId: string, actions: ResumeActions) =>
      new Runner({ ...deps, runId }).run(m, { actions });
    const three = manifest(agent("p1"), agent("p2"), agent("p3"));
    const killedAtP2: [string, RunEvent][] = [
      ["p1", { kind: "sent" }],
      ["p1", { kind: "done" }],
      ["p2", { kind: "sent" }],
    ];

    it("completes node 2 from the transcript without sending it, then sends node 3 once", async () => {
      const { deps, calls } = harness();
      const runId = seeded(deps, three, killedAtP2);

      const result = await resume(deps, three, runId, {
        p2: { kind: "complete", stopMessage: "X" },
      });

      expect(result.outcome).toBe("done");
      expect(sends(calls)).toEqual([turnOf("p3")]);
      expect(eventsOf(deps.store, "p2").slice(1)).toMatchObject([
        { kind: "done", payload: { stopMessage: "X" } },
      ]);
      expect(result.states).toEqual({ p1: "done", p2: "done", p3: "done" });
    });

    it("waits for node 2's Stop without sending it, then sends node 3", async () => {
      const { deps, calls, events } = harness();
      const runId = seeded(deps, three, killedAtP2);

      const running = resume(deps, three, runId, { p2: { kind: "wait" } });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sends(calls)).toEqual([]);
      expect(kindsOf(deps.store, "p2")).toEqual(["sent"]);
      events.publish({ kind: "Stop", sessionId, payload: {} });
      const result = await running;

      expect(result.outcome).toBe("done");
      expect(sends(calls)).toEqual([turnOf("p3")]);
      expect(kindsOf(deps.store, "p2")).toEqual(["sent", "done"]);
    });

    it.each([agent("p2"), agent("p2")])(
      "accepts a waited $type node's Stop stamped before the wait",
      async (waited) => {
        const { deps, events } = harness();
        deps.now = () => 2;
        const m = manifest(agent("p1"), waited);
        const runId = seeded(deps, m, killedAtP2);

        const running = resume(deps, m, runId, { p2: { kind: "wait" } });
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.publish({
          kind: "Stop",
          sessionId,
          payload: { flowdeck_hook_at: 1, last_assistant_message: "X" },
        });
        const result = await running;

        expect(result.outcome).toBe("done");
        expect(eventsOf(deps.store, "p2").slice(1)).toMatchObject([
          { kind: "done", payload: { stopMessage: "X" } },
        ]);
      },
    );

    it("sends node 2 exactly once without a second sent event", async () => {
      const { deps, calls } = harness();
      const runId = seeded(deps, three, killedAtP2);

      await resume(deps, three, runId, { p2: { kind: "send" } });

      expect(sends(calls)).toEqual([turnOf("p2"), turnOf("p3")]);
      expect(kindsOf(deps.store, "p2")).toEqual(["sent", "done"]);
    });

    it("resends node 2 with the answer it was sent with", async () => {
      const { deps, calls } = harness();
      const m = manifest(ask("q1"), agent("p1"));
      const runId = seeded(deps, m, [
        ["q1", { kind: "needs-you" }],
        [
          "q1",
          { kind: "answered", payload: { nodeId: "q1", decision: "answered", answer: "blue" } },
        ],
        ["q1", { kind: "done" }],
        ["p1", { kind: "sent" }],
      ]);

      await resume(deps, m, runId, { p1: { kind: "send" } });

      expect(sends(calls)).toEqual([turnOf("p1", { answers: ["blue"] })]);
    });

    it("keeps an answer given before the kill for the next Agent", async () => {
      const { deps, calls } = harness();
      const m = manifest(ask("q1"), agent("p1"));
      const runId = seeded(deps, m, [
        ["q1", { kind: "needs-you" }],
        [
          "q1",
          { kind: "answered", payload: { nodeId: "q1", decision: "answered", answer: "blue" } },
        ],
        ["q1", { kind: "done" }],
      ]);

      await resume(deps, m, runId, {});

      expect(sends(calls)).toEqual([turnOf("p1", { answers: ["blue"] })]);
    });

    describe("a Gate waiting on a human", () => {
      const m = manifest(agent("p1"), gate("g1"), agent("p2"));
      const asking: [string, RunEvent][] = [
        ["p1", { kind: "sent" }],
        ["p1", { kind: "done" }],
        ["g1", { kind: "needs-you" }],
      ];

      it("reuses the decision recorded before the kill without asking", async () => {
        const waiter = new FakeWaiter([]);
        const { deps, calls } = harness({ waiter });
        const decision = { nodeId: "g1", decision: "approved" } as const;
        const runId = seeded(deps, m, [...asking, ["g1", { kind: "decided", payload: decision }]]);

        const result = await resume(deps, m, runId, { g1: { kind: "reuse", decision } });

        expect(waiter.calls).toEqual([]);
        expect(kindsOf(deps.store, "g1")).toEqual(["needs-you", "decided", "done"]);
        expect(sends(calls)).toEqual([turnOf("p2")]);
        expect(result.decisions).toEqual([decision]);
      });

      it("asks once when no decision was recorded", async () => {
        const waiter = new FakeWaiter([approve]);
        const { deps } = harness({ waiter });
        const runId = seeded(deps, m, asking);

        const result = await resume(deps, m, runId, { g1: { kind: "ask" } });

        expect(waiter.calls).toHaveLength(1);
        expect(kindsOf(deps.store, "g1")).toEqual(["needs-you", "decided", "done"]);
        expect(result.outcome).toBe("done");
      });
    });

    it.each([
      [
        "gate",
        { nodeId: "h1", decision: "rejected", reason: "wrong scope" },
        { shown: "Check the plan", skippable: false },
        "h1 failed: rejected: wrong scope",
      ],
      [
        "hardstop",
        { nodeId: "h1", decision: "stopped", reason: "tests fail" },
        { condition: "tests fail", shown: "Check tests", locked: true, enabled: true },
        "h1 failed: stopped: tests fail",
      ],
      [
        "hardstop",
        { nodeId: "h1", decision: "continued" },
        { condition: "tests fail", shown: "Check tests", locked: true, enabled: true },
        "h1 continued",
      ],
    ] as const)(
      "reuses a recorded %s decision %o with the outcome it had",
      async (type, decision, settings, line) => {
        const waiter = new FakeWaiter([]);
        const { deps, lines } = harness({ waiter });
        const m = manifest(node("h1", type, settings));
        const runId = seeded(deps, m, [
          ["h1", { kind: "needs-you" }],
          ["h1", { kind: "decided", payload: decision }],
        ]);

        await resume(deps, m, runId, { h1: { kind: "reuse", decision } });

        expect(waiter.calls).toEqual([]);
        expect(lines).toEqual([line]);
      },
    );

    it("reuses an Ask answer recorded before the kill for the next Agent", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls } = harness({ waiter });
      const m = manifest(ask("q1"), agent("p1"));
      const decision = { nodeId: "q1", decision: "answered", answer: "blue" } as const;
      const runId = seeded(deps, m, [
        ["q1", { kind: "needs-you" }],
        ["q1", { kind: "answered", payload: decision }],
      ]);

      await resume(deps, m, runId, { q1: { kind: "reuse", decision } });

      expect(waiter.calls).toEqual([]);
      expect(sends(calls)).toEqual([turnOf("p1", { answers: ["blue"] })]);
    });

    const loopAnswered = (answer: string) =>
      ["l1", { kind: "answered", payload: { nodeId: "l1", decision: "answered", answer } }] as [
        string,
        RunEvent,
      ];
    const loopAsking = (stopMessage: string): [string, RunEvent][] => [
      ["l1", { kind: "running" }],
      ["l1", { kind: "round", payload: { round: 1 } }],
      ["r1", { kind: "sent" }],
      ["r1", { kind: "done", payload: { stopMessage } }],
      ["l1", { kind: "needs-you" }],
    ];
    const reuseAnswer = (answer: string): ResumeActions => ({
      l1: { kind: "reuse", decision: { nodeId: "l1", decision: "answered", answer } },
    });

    it("reuses a Loop's recorded 'again' after a malformed verdict and runs round 2 without asking", async () => {
      const waiter = new FakeWaiter([]);
      const { deps } = harness({ waiter, replies: [verdict(true)] });
      const m = manifest(loop("l1"), inLoop(agent("r1")));
      const runId = seeded(deps, m, [...loopAsking("no verdict here"), loopAnswered("again")]);

      const result = await resume(deps, m, runId, reuseAnswer("again"));

      expect(waiter.calls).toEqual([]);
      expect(kindsOf(deps.store, "l1").filter((kind) => kind === "answered")).toHaveLength(1);
      const rounds = eventsOf(deps.store, "l1").flatMap((event) =>
        event.kind === "round" ? [event.payload.round] : [],
      );
      expect(rounds).toEqual([1, 2]);
      expect(result.outcome).toBe("done");
    });

    it("reuses a Loop's recorded 'continue' at the cap and ends the loop done without asking", async () => {
      const waiter = new FakeWaiter([]);
      const { deps } = harness({ waiter });
      const m = manifest(
        node("l1", "loop", { condition, cap: 1, onCap: "ask" }),
        inLoop(agent("r1")),
      );
      const runId = seeded(deps, m, [...loopAsking(verdict(false)), loopAnswered("continue")]);

      const result = await resume(deps, m, runId, reuseAnswer("continue"));

      expect(waiter.calls).toEqual([]);
      expect(nodeStatus(eventsOf(deps.store, "l1"))).toBe("done");
      expect(result.outcome).toBe("done");
    });

    it("continues a Loop from round 2, and its next round is 3", async () => {
      const { deps, calls, lines } = harness({ replies: ["review", verdict(true)] });
      const m = manifest(loop("l1"), inLoop(agent("r1")), inLoop(agent("f1")), agent("p9"));
      const runId = seeded(deps, m, [
        ["l1", { kind: "running" }],
        ["l1", { kind: "round", payload: { round: 1 } }],
        ["r1", { kind: "sent" }],
        ["r1", { kind: "done", payload: { stopMessage: "review" } }],
        ["f1", { kind: "sent" }],
        ["f1", { kind: "done", payload: { stopMessage: verdict(false) } }],
        ["l1", { kind: "round", payload: { round: 2 } }],
        ["r1", { kind: "reset" }],
        ["f1", { kind: "reset" }],
        ["r1", { kind: "sent" }],
        ["r1", { kind: "done", payload: { stopMessage: "review" } }],
        ["f1", { kind: "sent" }],
      ]);

      const result = await resume(deps, m, runId, {
        f1: { kind: "complete", stopMessage: verdict(false) },
      });

      const rounds = eventsOf(deps.store, "l1").flatMap((event) =>
        event.kind === "round" ? [event.payload.round] : [],
      );
      expect(rounds).toEqual([1, 2, 3]);
      expect(lines.filter((line) => /^l1 round/.test(line))).toEqual(["l1 round 3"]);
      expect(sends(calls)).toEqual([turnOf("r1"), turnOf("f1", { condition }), turnOf("p9")]);
      expect(result.outcome).toBe("done");
    });
  });
});

describe("Runner permission requests", () => {
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
  const approve: WaitReply = { decision: "approve" };
  const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
  const runIdOf = (store: FakeStore) => store.runs[0]?.id ?? "";
  const kindsOf = (store: FakeStore, nodeId: string) =>
    store
      .events(runIdOf(store))
      .filter((event) => event.nodeId === nodeId)
      .map((event) => event.kind);
  const deferred = () => {
    let resolve: (reply: WaitReply) => void = () => undefined;
    const promise = new Promise<WaitReply>((r) => (resolve = r));
    return { promise, resolve };
  };
  async function askDuringTurn(waiter: FakeWaiter, options: { auto?: boolean } = {}) {
    const permissions = new FakePermissionSource();
    const h = harness({ waiter, permissions, stop: "never", ...options });
    const running = runOn(h.deps, manifest(agent("n1")));
    await vi.waitFor(() => expect(sends(h.calls)).toHaveLength(1));
    const decision = await permissions.ask(sessionId, bash("echo hi"));
    h.events.publish({ kind: "PostToolUse", sessionId, payload: agentDonePayload("n1") });
    h.events.publish({ kind: "Stop", sessionId, payload: {} });
    return { ...h, decision, result: await running };
  }

  it("asks the waiter for the agent node in its turn and allows on approve", async () => {
    const waiter = new FakeWaiter([approve]);

    const { decision, result } = await askDuringTurn(waiter);

    expect(waiter.calls).toEqual([permissionWait]);
    expect(decision).toEqual({ behavior: "allow" });
    expect(result.outcome).toBe("done");
  });

  it("denies with the reject reason", async () => {
    const waiter = new FakeWaiter([{ decision: "reject", reason: "no" }]);

    const { decision } = await askDuringTurn(waiter);

    expect(decision).toEqual({ behavior: "deny", message: "no" });
  });

  it("marks the node needs you while a permission wait is open, and running again after the answer", async () => {
    const reply = deferred();
    const permissions = new FakePermissionSource();
    const h = harness({ waiter: new FakeWaiter([reply.promise]), permissions, stop: "never" });
    const running = runOn(h.deps, manifest(agent("n1")));
    await vi.waitFor(() => expect(sends(h.calls)).toHaveLength(1));

    const asked = permissions.ask(sessionId, bash("echo hi"));
    await vi.waitFor(() => expect(kindsOf(h.deps.store, "n1")).toEqual(["sent", "needs-you"]));
    reply.resolve(approve);
    await asked;
    expect(kindsOf(h.deps.store, "n1")).toEqual(["sent", "needs-you", "running"]);

    h.events.publish({ kind: "PostToolUse", sessionId, payload: agentDonePayload("n1") });
    h.events.publish({ kind: "Stop", sessionId, payload: {} });
    expect((await running).states["n1"]).toBe("done");
  });

  it("still asks under auto", async () => {
    const waiter = new FakeWaiter([approve]);

    const { decision } = await askDuringTurn(waiter, { auto: true });

    expect(waiter.calls).toEqual([permissionWait]);
    expect(decision).toEqual({ behavior: "allow" });
  });

  it("denies with the waiter's error when the waiter throws", async () => {
    const { decision, result } = await askDuringTurn(new FakeWaiter([]));

    expect(decision).toEqual({
      behavior: "deny",
      message: "FakeWaiter: no scripted reply for n1",
    });
    expect(result.outcome).toBe("done");
  });

  it("asks for the agent node in its turn", async () => {
    const waiter = new FakeWaiter([approve]);
    const permissions = new FakePermissionSource();
    const { deps, events, calls } = harness({ waiter, permissions, stop: "never" });

    const running = runOn(deps, manifest(agent("a1")));
    await vi.waitFor(() => expect(sends(calls)).toHaveLength(1));
    const decision = await permissions.ask(sessionId, bash("echo hi"));
    events.publish({ kind: "PostToolUse", sessionId, payload: agentDonePayload("a1") });
    events.publish({ kind: "Stop", sessionId, payload: {} });
    const result = await running;

    expect(waiter.calls).toEqual([{ ...permissionWait, nodeId: "a1" }]);
    expect(decision).toEqual({ behavior: "allow" });
    expect(result.outcome).toBe("done");
  });

  it.each([
    ["before the first send", (gate: ManifestNode) => [gate, agent("n1")]],
    ["after the turn ends", (gate: ManifestNode) => [agent("n1"), gate]],
  ])("denies without asking while no turn is open, %s", async (_when, around) => {
    let resolve: (reply: WaitReply) => void = () => undefined;
    const waiter = new FakeWaiter([new Promise<WaitReply>((r) => (resolve = r))]);
    const permissions = new FakePermissionSource();
    const { deps } = harness({ waiter, permissions });
    const gate = node("g1", "gate", { shown: "Check the plan", skippable: false });

    const running = runOn(deps, manifest(...around(gate)));
    await vi.waitFor(() => expect(waiter.calls).toHaveLength(1));
    const decision = await permissions.ask(sessionId, bash("echo hi"));
    resolve({ decision: "approve" });
    await running;

    expect(decision).toEqual({ behavior: "deny", message: "No node is running" });
    expect(waiter.calls.map((call) => call.nodeId)).toEqual(["g1"]);
  });

  it("denies without asking once the run is over", async () => {
    const waiter = new FakeWaiter([]);
    const permissions = new FakePermissionSource();
    const { deps } = harness({ waiter, permissions });
    await runOn(deps, manifest(agent("n1")));

    const decision = await permissions.ask(sessionId, bash("echo hi"));

    expect(decision.behavior).toBe("deny");
    expect(waiter.calls).toEqual([]);
  });

  it("gives two concurrent asks one wait each, resolved in the waiter's reply order", async () => {
    const first = deferred();
    const second = deferred();
    const waiter = new FakeWaiter([first.promise, second.promise]);
    const permissions = new FakePermissionSource();
    const { deps, events, calls } = harness({ waiter, permissions, stop: "never" });
    const running = runOn(deps, manifest(agent("n1")));
    await vi.waitFor(() => expect(sends(calls)).toHaveLength(1));

    const one = permissions.ask(sessionId, bash("echo one"));
    const two = permissions.ask(sessionId, bash("echo two"));
    await vi.waitFor(() => expect(waiter.calls).toHaveLength(2));
    second.resolve({ decision: "reject", reason: "no" });
    expect(await two).toEqual({ behavior: "deny", message: "no" });
    first.resolve(approve);
    expect(await one).toEqual({ behavior: "allow" });
    events.publish({ kind: "PostToolUse", sessionId, payload: agentDonePayload("n1") });
    events.publish({ kind: "Stop", sessionId, payload: {} });
    await running;

    expect(waiter.calls.map((call) => (call.kind === "permission" ? call.input : ""))).toEqual([
      "echo one",
      "echo two",
    ]);
  });

  it("withdraws an ask whose hook went away, so the turn timeout fires again", async () => {
    let handed: AbortSignal | undefined;
    const waiter = {
      wait: (_request: WaitRequest, signal?: AbortSignal) => {
        handed = signal;
        return new Promise<WaitReply>(() => {});
      },
    };
    const permissions = new FakePermissionSource();
    const { deps, calls } = harness({ permissions, stop: "never" });
    const running = runOn({ ...deps, waiter, turnTimeoutMs: 50 }, manifest(agent("n1")));
    await vi.waitFor(() => expect(sends(calls)).toHaveLength(1));
    const hook = new AbortController();

    const asked = permissions.ask(sessionId, bash("echo hi"), hook.signal);
    await vi.waitFor(() => expect(handed).toBeDefined());
    hook.abort();

    expect((await asked).behavior).toBe("deny");
    expect(handed?.aborted).toBe(true);
    expect(await running).toMatchObject({ outcome: "failed", failedNode: "n1" });
  });

  it("holds the turn timeout while an ask is open", async () => {
    const pending = deferred();
    const waiter = new FakeWaiter([pending.promise]);
    const permissions = new FakePermissionSource();
    const { deps, events, calls } = harness({ waiter, permissions, stop: "never" });
    const running = runOn({ ...deps, turnTimeoutMs: 50 }, manifest(agent("n1")));
    await vi.waitFor(() => expect(sends(calls)).toHaveLength(1));

    const asked = permissions.ask(sessionId, bash("echo hi"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    events.publish({ kind: "PostToolUse", sessionId, payload: agentDonePayload("n1") });
    events.publish({ kind: "Stop", sessionId, payload: {} });
    pending.resolve(approve);
    await asked;
    const result = await running;

    expect(result.outcome).toBe("done");
    expect(result.states).toEqual({ n1: "done" });
  });
});

describe("Runner budget", () => {
  const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
  const runIdOf = (store: FakeStore) => store.runs[0]?.id ?? "";
  const eventsOf = (store: FakeStore, nodeId: string) =>
    store.events(runIdOf(store)).filter((event) => event.nodeId === nodeId);
  const kindsOf = (store: FakeStore, nodeId: string) =>
    eventsOf(store, nodeId).map((event) => event.kind);
  const spent = (outputTokens: number): UsageEntry[] => [
    {
      messageId: "m1",
      model: "claude-opus-5-5",
      inputTokens: 0,
      outputTokens,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    },
  ];
  const dollars120 = 60_000;
  const twoAgents = manifest(agent("n1"), agent("n2"));
  const stop: WaitReply = { decision: "stop", reason: "too much" };

  function spendAfterFirstSend(options: { waiter: FakeWaiter; budget?: number; tokens?: number }) {
    const usage = new FakeUsageSource();
    const h = harness({
      waiter: options.waiter,
      usage,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    });
    const send = h.deps.prompts.sendPrompt;
    h.deps.prompts = {
      interrupt: async () => undefined,
      sendPrompt: async (text) => {
        await send(text);
        usage.setEntries(sessionId, spent(options.tokens ?? dollars120));
      },
    };
    return { ...h, usage };
  }

  it("asks with the spend before sending the next agent once spend passes the budget", async () => {
    let resolve: (reply: WaitReply) => void = () => undefined;
    const waiter = new FakeWaiter([new Promise<WaitReply>((r) => (resolve = r))]);
    const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1 });

    const running = runOn(deps, twoAgents);
    await vi.waitFor(() => expect(waiter.calls).toHaveLength(1));

    expect(waiter.calls).toEqual([budgetWait]);
    expect(sends(calls)).toEqual([turnOf("n1")]);
    expect(kindsOf(deps.store, "n2")).not.toContain("sent");
    resolve(stop);
    await running;
  });

  it("sends the paused node once after a raise, without restarting the run", async () => {
    const waiter = new FakeWaiter([{ decision: "raise", budget: 2 }]);
    const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1 });

    const result = await runOn(deps, twoAgents);

    expect(result.outcome).toBe("done");
    expect(sends(calls)).toEqual([turnOf("n1"), turnOf("n2")]);
    expect(kindsOf(deps.store, "n1").filter((kind) => kind === "sent")).toHaveLength(1);
    expect(eventsOf(deps.store, "n2")).toMatchObject([
      { kind: "budget", payload: { step: "paused", spend: 1.2, budget: 1 } },
      { kind: "budget", payload: { step: "raised", budget: 2 } },
      { kind: "sent" },
      { kind: "done" },
    ]);
  });

  it("pauses when the spend equals the budget", async () => {
    const waiter = new FakeWaiter([stop]);
    const { deps } = spendAfterFirstSend({ waiter, budget: 1, tokens: 50_000 });

    await runOn(deps, twoAgents);

    expect(waiter.calls).toEqual([{ ...budgetWait, spend: 1 }]);
  });

  it("does not wait while the spend is below the budget", async () => {
    const waiter = new FakeWaiter([]);
    const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1, tokens: 49_500 });

    const result = await runOn(deps, twoAgents);

    expect(waiter.calls).toEqual([]);
    expect(result.outcome).toBe("done");
    expect(sends(calls)).toHaveLength(2);
  });

  it("never reads usage without a budget", async () => {
    const waiter = new FakeWaiter([]);
    const { deps, usage } = spendAfterFirstSend({ waiter });

    const result = await runOn(deps, twoAgents);

    expect(usage.calls).toEqual([]);
    expect(result.outcome).toBe("done");
  });

  it("checks a loop body agent before its send", async () => {
    const waiter = new FakeWaiter([stop]);
    const usage = new FakeUsageSource();
    usage.setEntries(sessionId, spent(dollars120));
    const { deps, calls } = harness({ waiter, usage, budget: 1 });
    const loop = node("l1", "loop", { condition: "no issues left", cap: 3, onCap: "fail" });

    const result = await runOn(deps, manifest(loop, { ...agent("r1"), parent: "l1" }));

    expect(waiter.calls).toEqual([{ ...budgetWait, nodeId: "r1" }]);
    expect(sends(calls)).toEqual([]);
    expect(result.outcome).toBe("failed");
  });

  it("still waits under auto", async () => {
    const waiter = new FakeWaiter([stop]);
    const usage = new FakeUsageSource();
    usage.setEntries(sessionId, spent(dollars120));
    const { deps } = harness({ waiter, usage, budget: 1, auto: true });

    await runOn(deps, manifest(agent("n1")));

    expect(waiter.calls).toEqual([{ ...budgetWait, nodeId: "n1" }]);
  });

  it.each<WaitReply>([stop, { decision: "closed" }])(
    "fails the run at the paused node on $decision, leaving it waiting",
    async (reply) => {
      const waiter = new FakeWaiter([reply]);
      const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1 });

      const result = await runOn(deps, twoAgents);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "n2" });
      expect(result.states).toEqual({ n1: "done", n2: "waiting" });
      expect(sends(calls)).toEqual([turnOf("n1")]);
      expect(eventsOf(deps.store, "n2").at(-1)).toMatchObject({
        kind: "budget",
        payload: { step: "stopped" },
      });
    },
  );

  describe("after a turn ends", () => {
    const message = (messageId: string, outputTokens: number, text?: string): UsageEntry => ({
      model: "claude-opus-5-5",
      inputTokens: 0,
      outputTokens,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      messageId,
      ...(text === undefined ? {} : { text }),
    });

    function landingLate(options: {
      before?: UsageEntry[];
      stale: UsageEntry[];
      landed: UsageEntry[];
      settleMs?: number;
      reply?: string;
    }) {
      const waiter = new FakeWaiter([stop]);
      const usage = new FakeUsageSource();
      usage.setEntries(sessionId, options.before ?? []);
      const replies = [options.reply ?? "OK", "DONE."];
      const h = harness({ waiter, usage, budget: 1, replies });
      const send = h.deps.prompts.sendPrompt;
      let sent = 0;
      h.deps.prompts = {
        interrupt: async () => undefined,
        sendPrompt: async (text) => {
          await send(text);
          if (sent++ > 0) return;
          usage.setEntries(sessionId, options.landed);
          usage.queueReads(sessionId, options.stale);
        },
      };
      if (options.settleMs !== undefined) h.deps.usageSettleMs = options.settleMs;
      return { ...h, waiter };
    }

    it("waits for the finished turn's usage before checking the budget", async () => {
      const { deps, calls, waiter } = landingLate({
        stale: [],
        landed: [message("m1", dollars120, "OK")],
      });

      await runOn(deps, twoAgents);

      expect(waiter.calls).toEqual([budgetWait]);
      expect(sends(calls)).toEqual([turnOf("n1")]);
      expect(kindsOf(deps.store, "n2")).not.toContain("sent");
    });

    it.each([
      { reply: "OK", text: "OK" },
      { reply: "OK\n", text: " OK" },
    ])(
      "carries on once the Stop's message $reply lands below the budget as $text",
      async ({ reply, text }) => {
        const { deps, calls, waiter } = landingLate({
          stale: [],
          landed: [message("m1", 1_000, text)],
          settleMs: 60_000,
          reply,
        });

        const result = await runOn(deps, twoAgents);

        expect(result.outcome).toBe("done");
        expect(waiter.calls).toEqual([]);
        expect(sends(calls)).toHaveLength(2);
      },
    );

    it("waits for the message the Stop names, not an earlier one of the same turn", async () => {
      const toolUse = message("m1", 0);
      const { deps, waiter } = landingLate({
        stale: [toolUse],
        landed: [toolUse, message("m2", dollars120, "OK")],
      });

      await runOn(deps, twoAgents);

      expect(waiter.calls).toEqual([budgetWait]);
    });

    it("does not take a matching message from before the send for the turn's", async () => {
      const earlier = message("m0", 0, "OK");
      const { deps, waiter } = landingLate({
        before: [earlier],
        stale: [earlier],
        landed: [earlier, message("m1", dollars120, "OK")],
      });

      await runOn(deps, twoAgents);

      expect(waiter.calls).toEqual([budgetWait]);
    });

    it("waits for the Stop's message after resuming into a turn sent before", async () => {
      const waiter = new FakeWaiter([stop]);
      const usage = new FakeUsageSource();
      usage.setEntries(sessionId, [message("m1", dollars120, "OK")]);
      usage.queueReads(sessionId, []);
      const { deps, calls, events } = harness({ waiter, usage, budget: 1 });
      const { id } = deps.store.createRun(newRun(twoAgents));
      deps.store.append(id, "n1", { kind: "sent" });

      const running = new Runner({ ...deps, runId: id }).run(twoAgents, {
        actions: { n1: { kind: "wait" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.publish({ kind: "Stop", sessionId, payload: { last_assistant_message: "OK" } });
      await running;

      expect(waiter.calls).toEqual([budgetWait]);
      expect(sends(calls)).toEqual([]);
      expect(kindsOf(deps.store, "n2")).not.toContain("sent");
    });

    it("reports the budget reached when a read missing the Stop's message is already over it", async () => {
      const toolUse = message("m1", dollars120);
      const { deps, waiter, lines } = landingLate({
        stale: [toolUse],
        landed: [toolUse],
        settleMs: 100,
      });

      await runOn(deps, twoAgents);

      expect(waiter.calls).toEqual([budgetWait]);
      expect(eventsOf(deps.store, "n2")[0]).toEqual(
        expect.objectContaining({
          kind: "budget",
          payload: { step: "paused", spend: 1.2, budget: 1 },
        }),
      );
      expect(lines).toContain("n2 failed: budget reached: spent $1.20 of $1.00");
    });

    it("pauses with the spend it read when the turn's usage never lands", async () => {
      const { deps, calls, waiter, lines } = landingLate({
        stale: [],
        landed: [],
        settleMs: 100,
      });

      await runOn(deps, twoAgents);

      expect(waiter.calls).toEqual([{ ...budgetWait, spend: 0, unconfirmed: true }]);
      expect(sends(calls)).toEqual([turnOf("n1")]);
      expect(eventsOf(deps.store, "n2")[0]).toMatchObject({
        kind: "budget",
        payload: { step: "paused", spend: 0, budget: 1, unconfirmed: true },
      });
      expect(lines).toContain("n2 paused: spend not confirmed yet, last read $0.0000 of $1.00");
      expect(lines).toContain(
        "n2 failed: spend not confirmed: last read $0.0000 of $1.00 when the budget was checked",
      );
    });
  });

  it("pauses again on resume of a run paused at its budget", async () => {
    const waiter = new FakeWaiter([stop]);
    const usage = new FakeUsageSource();
    usage.setEntries(sessionId, spent(dollars120));
    const { deps, calls } = harness({ waiter, usage, budget: 1 });
    const { id } = deps.store.createRun(newRun(twoAgents));
    const paused = { kind: "budget", payload: { step: "paused", spend: 1.2, budget: 1 } };
    deps.store.append(id, "n1", { kind: "sent" });
    deps.store.append(id, "n1", { kind: "done" });
    deps.store.append(id, "n2", paused as RunEvent);

    const result = await new Runner({ ...deps, runId: id }).run(twoAgents, { actions: {} });

    expect(waiter.calls).toEqual([budgetWait]);
    expect(sends(calls)).toEqual([]);
    expect(result).toMatchObject({ outcome: "failed", failedNode: "n2" });
  });
});

describe("Runner parallel section", () => {
  const quietMs = 30;
  const branchIds = ["a1", "a2", "a3"];
  const typeOf = (id: string) => `${prefix}:${id}`;
  const forkBranches = (ids: readonly string[]) => ids.map((id) => ({ ...bare(id), piece: id }));
  const forkSend = (ids = branchIds) => `send ${forkTurnText(prefix, forkBranches(ids))}`;
  const afterSend = turnOf("after");
  const approve: WaitReply = { decision: "approve" };
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
  const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
  const runIdOf = (store: FakeStore) => store.runs[0]?.id ?? "";
  const eventsOf = (store: FakeStore, nodeId: string) =>
    store.events(runIdOf(store)).filter((event) => event.nodeId === nodeId);
  const kindsOf = (store: FakeStore, nodeId: string) =>
    eventsOf(store, nodeId).map((event) => event.kind);
  const timeline = (store: FakeStore) =>
    store.events(runIdOf(store)).map((event) => `${event.nodeId} ${event.kind}`);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const deferred = () => {
    let resolve: (reply: WaitReply) => void = () => undefined;
    const promise = new Promise<WaitReply>((r) => (resolve = r));
    return { promise, resolve };
  };

  function sectionManifest(
    options: {
      branches?: string[];
      wait?: "all" | "first";
      after?: boolean;
      onBranchFail?: "wait" | "skip" | "stop";
    } = {},
  ): RunnableManifest {
    const ids = options.branches ?? branchIds;
    const withAfter = options.after ?? true;
    const flow = builders.flow(
      [
        builders.fork("f"),
        ...ids.map((id) => builders.agent(id)),
        builders.join("j", {
          settings: { wait: options.wait ?? "all", onBranchFail: options.onBranchFail ?? "stop" },
        }),
        ...(withAfter ? [builders.agent("after")] : []),
      ],
      [
        ...ids.map((id) => builders.thenWire("f", id)),
        ...ids.map((id) => builders.thenWire(id, "j")),
        ...(withAfter ? [builders.thenWire("j", "after")] : []),
      ],
    );
    const { nodes, wires } = lower(flow, { name: prefix, values: {} }).manifest;
    return { hash, prefix, nodes, wires };
  }

  type Session = {
    launch: (id: string, type?: string) => void;
    subagentStop: (id: string, reply?: string, type?: string) => void;
    stop: (reply?: string) => void;
    failTurn: (reply: string) => void;
  };
  type Turn = (session: Session) => void;

  function sectionHarness(
    options: {
      onFork?: Turn;
      onInterrupt?: Turn;
      waiter?: FakeWaiter;
      permissions?: FakePermissionSource;
      usage?: FakeUsageSource;
      budget?: number;
      turnTimeoutMs?: number;
    } = {},
  ) {
    const events = new FakeEventSource();
    const calls: string[] = [];
    const lines: string[] = [];
    let clock = 1000;
    const publish = (
      kind: "Stop" | "StopFailure" | "PostToolUse" | "PreToolUse",
      payload: object,
    ) => {
      calls.push(`event ${kind} ${JSON.stringify(payload)}`);
      events.publish({ kind, sessionId, payload: { ...payload, flowdeck_hook_at: ++clock } });
    };
    const session: Session = {
      launch: (id, type = typeOf(id)) =>
        publish("PreToolUse", {
          tool_name: "Agent",
          tool_input: { subagent_type: type, prompt: `NODE ${id}\nGo` },
          tool_use_id: `toolu-${id}`,
        }),
      subagentStop: (id, reply, type = typeOf(id)) =>
        publish("PostToolUse", agentDonePayload(id, type, reply)),
      stop: (reply) =>
        publish("Stop", reply === undefined ? {} : { last_assistant_message: reply }),
      failTurn: (reply) =>
        publish("StopFailure", { error: "authentication_failed", last_assistant_message: reply }),
    };
    const onFork =
      options.onFork ??
      ((s: Session) => {
        for (const id of branchIds) s.launch(id);
        s.stop("Launched.");
      });
    const deps: TestDeps & { settleQuietMs: number } = {
      store: new FakeStore(),
      prompts: {
        sendPrompt: async (text) => {
          calls.push(`send ${text}`);
          if (text.startsWith("Use the Agent tool once for each")) onFork(session);
          else if (text === agentTurnText(prefix, "after", bare("after"))) {
            session.subagentStop("after", "OK");
            session.stop("OK");
          }
        },
        interrupt: async () => {
          calls.push("interrupt");
          options.onInterrupt?.(session);
        },
      },
      session: { ensureStarted: async () => undefined },
      events,
      waiter: options.waiter ?? new FakeWaiter([]),
      files: new FakeFileSystem(),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      onChange: (line) => lines.push(line),
      cwd,
      sessionId,
      turnTimeoutMs: options.turnTimeoutMs ?? 500,
      now: () => clock,
      settleQuietMs: quietMs,
    };
    const finishBranches = (ids = branchIds) => {
      for (const id of ids) session.subagentStop(id, `${id} reply`);
      session.stop("All done.");
    };
    return { deps, calls, lines, session, finishBranches };
  }

  const forkSent = (calls: string[]) =>
    vi.waitFor(() => expect(sends(calls)).toHaveLength(1), { timeout: 200 });
  const launchAll: Turn = (s) => {
    for (const id of branchIds) s.launch(id);
  };
  const sendsAndInterrupts = (calls: string[]) =>
    calls.filter((call) => call.startsWith("send") || call === "interrupt");

  it("sends one fork turn and marks the fork, each branch and the join before any branch finishes", async () => {
    const h = sectionHarness();
    const running = runOn(h.deps, sectionManifest());
    await forkSent(h.calls);

    expect(sends(h.calls)).toEqual([forkSend()]);
    expect(timeline(h.deps.store)).toEqual([
      "f sent",
      "a1 sent",
      "a2 sent",
      "a3 sent",
      "j running",
    ]);
    h.finishBranches();
    await running;
  });

  it("waits for all: each branch is done at its finished Agent call, and the next node only after the settle", async () => {
    const waiter = new FakeWaiter([]);
    const h = sectionHarness({ waiter });
    const running = runOn(h.deps, sectionManifest());
    await forkSent(h.calls);

    h.session.subagentStop("a1", "a1 reply");
    await vi.waitFor(() => expect(kindsOf(h.deps.store, "a1")).toEqual(["sent", "done"]));
    expect(eventsOf(h.deps.store, "a1").at(-1)).toMatchObject({
      kind: "done",
      payload: { stopMessage: "a1 reply" },
    });
    expect(kindsOf(h.deps.store, "a2")).toEqual(["sent"]);
    h.session.stop("a1 noted");
    h.session.subagentStop("a2", "a2 reply");
    h.session.stop("a2 noted");
    h.session.subagentStop("a3", "a3 reply");
    await sleep(quietMs * 3);
    expect(sends(h.calls)).toEqual([forkSend()]);
    h.session.stop("DONE");
    await sleep(quietMs / 3);
    expect(sends(h.calls)).toEqual([forkSend()]);
    const result = await running;

    expect(result.outcome).toBe("done");
    expect(sends(h.calls)).toEqual([forkSend(), afterSend]);
    for (const id of ["a2", "a3"]) {
      expect(eventsOf(h.deps.store, id).at(-1)).toMatchObject({
        kind: "done",
        payload: { stopMessage: `${id} reply` },
      });
    }
    const order = timeline(h.deps.store);
    expect(order.indexOf("j done")).toBeGreaterThan(order.indexOf("a3 done"));
    expect(order.indexOf("f done")).toBeGreaterThan(order.indexOf("j done"));
    expect(eventsOf(h.deps.store, "f").at(-1)).toMatchObject({
      kind: "done",
      payload: { stopMessage: "DONE" },
    });
    expect(waiter.calls).toEqual([]);
  });

  it("stores the value a branch produces, for a Branch after the join to read", async () => {
    const fence = "```";
    const flow = builders.flow(
      [
        builders.fork("f"),
        builders.agent("a1", { settings: { produces: "a" } }),
        builders.agent("a2"),
        builders.join("j", { settings: { wait: "all", onBranchFail: "stop" } }),
        {
          ...builders.branch("b", ""),
          settings: { variable: "", decidedBy: "value", value: "a" },
        },
        builders.agent("after"),
        builders.agent("other"),
      ],
      [
        builders.thenWire("f", "a1"),
        builders.thenWire("f", "a2"),
        builders.thenWire("a1", "j"),
        builders.thenWire("a2", "j"),
        builders.thenWire("j", "b"),
        builders.wire("b", "yes", "after", "in"),
        builders.wire("b", "no", "other", "in"),
      ],
    );
    const { nodes, wires } = lower(flow, { name: prefix, values: {} }).manifest;
    const h = sectionHarness({
      onFork: (s) => {
        s.launch("a1");
        s.launch("a2");
        s.stop("Launched.");
      },
    });
    const running = runOn(h.deps, { hash, prefix, nodes, wires });
    await forkSent(h.calls);

    h.session.subagentStop("a1", `Checked.\n${fence}json\n{"a": true}\n${fence}`);
    h.session.subagentStop("a2", "a2 reply");
    h.session.stop("All done.");
    const result = await running;

    expect(eventsOf(h.deps.store, "a1").at(-1)).toMatchObject({
      kind: "done",
      payload: { produced: { name: "a", answer: true } },
    });
    expect(result.outcome).toBe("done");
    expect(result.states).toMatchObject({ b: "done", after: "done", other: "skipped" });
  });

  it("does not complete a three-branch join on a duplicate finished call", async () => {
    const h = sectionHarness();
    const running = runOn(h.deps, sectionManifest());
    await forkSent(h.calls);

    h.session.subagentStop("a1", "a1 reply");
    h.session.subagentStop("a1", "a1 again");
    h.session.subagentStop("a2", "a2 reply");
    h.session.stop("Two of three.");
    await sleep(quietMs * 3);

    expect(sends(h.calls)).toEqual([forkSend()]);
    expect(kindsOf(h.deps.store, "j")).toEqual(["running"]);
    expect(kindsOf(h.deps.store, "a3")).toEqual(["sent"]);
    h.finishBranches(["a3"]);
    expect((await running).outcome).toBe("done");
  });

  it("waits for first: interrupts at the first finished branch without waiting for a Stop, skips the rest, then runs the next node", async () => {
    const h = sectionHarness({ onFork: launchAll });
    const running = runOn(h.deps, sectionManifest({ wait: "first" }));
    await forkSent(h.calls);

    expect(sends(h.calls)).toEqual([forkSend()]);
    expect(h.calls).not.toContain("interrupt");
    h.session.subagentStop("a2", "a2 reply");
    const result = await running;

    expect(result.outcome).toBe("done");
    expect(result.states).toEqual({
      f: "done",
      a1: "skipped",
      a2: "done",
      a3: "skipped",
      j: "done",
      after: "done",
    });
    expect(sendsAndInterrupts(h.calls)).toEqual([forkSend(), "interrupt", afterSend]);
    expect(h.calls.filter((call) => call.startsWith("event Stop"))).toEqual([
      'event Stop {"last_assistant_message":"OK"}',
    ]);
    const order = timeline(h.deps.store);
    expect(order.indexOf("a1 skipped")).toBeGreaterThan(order.indexOf("a2 done"));
    expect(order.indexOf("j done")).toBeGreaterThan(order.indexOf("a3 skipped"));
    expect(order.indexOf("f done")).toBeGreaterThan(order.indexOf("j done"));
    const forkDone = eventsOf(h.deps.store, "f").at(-1);
    expect(forkDone).toMatchObject({ kind: "done" });
    expect(forkDone).not.toHaveProperty("payload.stopMessage");
  });

  it("waits for first: a sibling that stops while the session is interrupted ends done, not skipped", async () => {
    const h = sectionHarness({
      onFork: launchAll,
      onInterrupt: (s) => s.subagentStop("a3", "a3 reply"),
    });
    const running = runOn(h.deps, sectionManifest({ wait: "first" }));
    await forkSent(h.calls);

    h.session.subagentStop("a2", "a2 reply");
    const result = await running;

    expect(result.states).toMatchObject({ a1: "skipped", a2: "done", a3: "done", j: "done" });
    expect(eventsOf(h.deps.store, "a3").at(-1)).toMatchObject({
      kind: "done",
      payload: { stopMessage: "a3 reply" },
    });
  });

  it("waits for first: fails the section when the interrupt fails", async () => {
    const h = sectionHarness({
      onFork: launchAll,
      onInterrupt: () => {
        throw new Error("still busy");
      },
    });
    const running = runOn(h.deps, sectionManifest({ wait: "first" }));
    await forkSent(h.calls);

    h.session.subagentStop("a2", "a2 reply");
    const result = await running;

    expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
    expect(result.states).toMatchObject({ f: "failed", a1: "failed", a2: "done", j: "failed" });
    expect(sendsAndInterrupts(h.calls)).toEqual([forkSend(), "interrupt"]);
    expect(eventsOf(h.deps.store, "j").at(-1)).toMatchObject({
      kind: "failed",
      payload: { message: "j failed: still busy" },
    });
  });

  it("waits for first: fails the section when a branch never launched, after the interrupt and without a cancel turn", async () => {
    const h = sectionHarness({
      onFork: (s) => {
        s.launch("a1");
        s.launch("a2");
      },
    });
    const running = runOn(h.deps, sectionManifest({ wait: "first" }));
    await forkSent(h.calls);

    h.session.subagentStop("a1", "a1 reply");
    const result = await running;

    expect(sendsAndInterrupts(h.calls)).toEqual([forkSend(), "interrupt"]);
    expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
    expect(result.states).toMatchObject({
      f: "failed",
      a1: "done",
      a2: "failed",
      a3: "failed",
      j: "failed",
    });
    expect(eventsOf(h.deps.store, "a2").at(-1)).toMatchObject({
      kind: "failed",
      payload: { message: "a2 failed: not started: a3" },
    });
  });

  describe("when a branch never starts", () => {
    const twoOfThree: Turn = (s) => {
      s.launch("a1");
      s.launch("a2");
      s.subagentStop("a1", "a1 reply");
      s.subagentStop("a2", "a2 reply");
      s.stop("Launched two.");
    };
    const notStarted = {
      nodeId: "j",
      kind: "ask",
      question: "a3 did not start. Go on without it?",
      options: ["continue", "stop"],
    };

    it("goes on without it when the Join says skip", async () => {
      const h = sectionHarness({ onFork: twoOfThree });

      const result = await runOn(h.deps, sectionManifest({ onBranchFail: "skip" }));

      expect(result.outcome).toBe("done");
      expect(result.states).toEqual({
        f: "done",
        a1: "done",
        a2: "done",
        a3: "skipped",
        j: "done",
        after: "done",
      });
      expect(h.lines).toContain("a3 skipped");
      expect(sends(h.calls)).toEqual([forkSend(), turnOf("after")]);
    });

    it("waits for first and skips both the unfinished and the unstarted branch when the Join says skip", async () => {
      const h = sectionHarness({
        onFork: (s) => {
          s.launch("a1");
          s.launch("a2");
        },
      });
      const running = runOn(h.deps, sectionManifest({ wait: "first", onBranchFail: "skip" }));
      await forkSent(h.calls);

      h.session.subagentStop("a1", "a1 reply");
      const result = await running;

      expect(result.outcome).toBe("done");
      expect(result.states).toMatchObject({ a1: "done", a2: "skipped", a3: "skipped", j: "done" });
    });

    it.each([
      ["continue", "done", "skipped"],
      ["stop", "failed", "failed"],
    ] as const)("asks you when the Join says wait, and %s decides", async (answer, outcome, a3) => {
      const waiter = new FakeWaiter([{ decision: "answer", answer }]);
      const h = sectionHarness({ onFork: twoOfThree, waiter });

      const result = await runOn(h.deps, sectionManifest({ onBranchFail: "wait" }));

      expect(waiter.calls).toEqual([notStarted]);
      expect(result.outcome).toBe(outcome);
      expect(result.states).toMatchObject({ a3, j: outcome });
      expect(result.decisions).toEqual([{ nodeId: "j", decision: "answered", answer }]);
    });
  });

  it("fails the section and leaves a branch skipped for not starting as it is when another branch times out", async () => {
    const h = sectionHarness({
      onFork: (s) => {
        s.launch("a1");
        s.launch("a2");
        s.subagentStop("a1", "a1 reply");
        s.stop("Launched two.");
      },
      turnTimeoutMs: 100,
    });

    const result = await runOn(h.deps, sectionManifest({ onBranchFail: "skip" }));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
    expect(result.states).toEqual({
      f: "failed",
      a1: "done",
      a2: "failed",
      a3: "skipped",
      j: "failed",
      after: "waiting",
    });
    expect(kindsOf(h.deps.store, "a3")).toEqual(["sent", "skipped"]);
  });

  it("fails the section without another turn when a branch never launches", async () => {
    const h = sectionHarness({
      onFork: (s) => {
        s.launch("a1");
        s.launch("a2");
        s.subagentStop("a1", "a1 reply");
        s.subagentStop("a2", "a2 reply");
        s.stop("Launched two.");
      },
    });

    const result = await runOn(h.deps, sectionManifest());

    expect(sends(h.calls)).toEqual([forkSend()]);
    expect(result.outcome).toBe("failed");
    expect(result.states).toEqual({
      f: "failed",
      a1: "done",
      a2: "done",
      a3: "failed",
      j: "failed",
      after: "waiting",
    });
    expect(h.lines.at(-1)).toMatch(/a3/);
  });

  describe("a turn that fails", () => {
    const notLoggedIn = "Not logged in · Please run /login";

    it("waits for first: fails the section with the session's message when the fork turn fails", async () => {
      const h = sectionHarness({ onFork: (s) => s.failTurn(notLoggedIn), turnTimeoutMs: 60_000 });

      const result = await runOn(h.deps, sectionManifest({ wait: "first" }));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
      expect(result.states).toMatchObject({
        f: "failed",
        a1: "failed",
        a2: "failed",
        a3: "failed",
        j: "failed",
        after: "waiting",
      });
      expect(h.lines.at(-1)).toBe(`f failed: ${notLoggedIn}`);
      expect(eventsOf(h.deps.store, "j").at(-1)).toMatchObject({
        kind: "failed",
        payload: { message: `j failed: ${notLoggedIn}` },
      });
      expect(sends(h.calls)).toEqual([forkSend()]);
    }, 2000);

    it("waits for all: fails the section with the session's message when the fork turn fails", async () => {
      const h = sectionHarness({ turnTimeoutMs: 60_000 });
      const running = runOn(h.deps, sectionManifest());
      await forkSent(h.calls);

      for (const id of branchIds) h.session.subagentStop(id, `${id} reply`);
      h.session.failTurn(notLoggedIn);
      const result = await running;

      expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
      expect(result.states).toMatchObject({ a1: "done", a2: "done", a3: "done", j: "failed" });
      expect(h.lines.at(-1)).toBe(`f failed: ${notLoggedIn}`);
      expect(sends(h.calls)).toEqual([forkSend()]);
    }, 2000);
  });

  it("fails a branch that never stops at the turn timeout, with its join and fork", async () => {
    const h = sectionHarness({ turnTimeoutMs: 100 });
    const running = runOn(h.deps, sectionManifest());
    await forkSent(h.calls);

    h.session.subagentStop("a1", "a1 reply");
    h.session.subagentStop("a2", "a2 reply");
    h.session.stop("Two of three.");
    const result = await running;

    expect(result.outcome).toBe("failed");
    expect(result.states).toMatchObject({
      f: "failed",
      a1: "done",
      a2: "done",
      a3: "failed",
      j: "failed",
      after: "waiting",
    });
    expect(h.lines.at(-1)).toMatch(/no finished Agent call for session s1 within 100 ms/);
    expect(sends(h.calls)).not.toContain(afterSend);
  });

  it("holds the branch timeout while a permission ask is open", async () => {
    const pending = deferred();
    const waiter = new FakeWaiter([pending.promise]);
    const permissions = new FakePermissionSource();
    const h = sectionHarness({ waiter, permissions, turnTimeoutMs: 50 });
    const running = runOn(h.deps, sectionManifest());
    await forkSent(h.calls);

    const asked = permissions.ask(sessionId, bash("echo hi"));
    await sleep(150);
    h.finishBranches();
    pending.resolve(approve);
    await asked;
    const result = await running;

    expect(result.outcome).toBe("done");
    expect(result.states).toMatchObject({ a1: "done", a2: "done", a3: "done", j: "done" });
  });

  describe("budget", () => {
    const overBudget = (): UsageEntry[] => [
      {
        messageId: "m1",
        model: "claude-opus-5-5",
        inputTokens: 0,
        outputTokens: 60_000,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
    ];

    it("halts at the fork before anything is sent when the budget is reached", async () => {
      const usage = new FakeUsageSource();
      usage.setEntries(sessionId, overBudget());
      const waiter = new FakeWaiter([{ decision: "stop", reason: "too much" }]);
      const h = sectionHarness({ waiter, usage, budget: 1 });

      const result = await runOn(h.deps, sectionManifest());

      expect(waiter.calls).toEqual([{ ...budgetWait, nodeId: "f" }]);
      expect(sends(h.calls)).toEqual([]);
      expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
      for (const id of [...branchIds, "j"]) expect(kindsOf(h.deps.store, id)).toEqual([]);
    });

    it("checks the budget once, for the fork, and never for a branch", async () => {
      const usage = new FakeUsageSource();
      usage.setEntries(sessionId, overBudget());
      const waiter = new FakeWaiter([{ decision: "raise", budget: 2 }]);
      const h = sectionHarness({
        waiter,
        usage,
        budget: 1,
        onFork: (s) => {
          for (const id of branchIds) s.launch(id);
          for (const id of branchIds) s.subagentStop(id, `${id} reply`);
          s.stop("All done.");
        },
      });

      const result = await runOn(h.deps, sectionManifest({ after: false }));

      expect(result.outcome).toBe("done");
      expect(waiter.calls).toEqual([{ ...budgetWait, nodeId: "f" }]);
      expect(usage.calls).toEqual([sessionId]);
      for (const id of branchIds) expect(kindsOf(h.deps.store, id)).not.toContain("budget");
    });
  });

  describe("permission requests", () => {
    it("files a request while the branches run under the fork's id", async () => {
      const waiter = new FakeWaiter([approve]);
      const permissions = new FakePermissionSource();
      const h = sectionHarness({ waiter, permissions });
      const running = runOn(h.deps, sectionManifest());
      await forkSent(h.calls);

      const decision = await permissions.ask(sessionId, bash("echo hi"));
      h.finishBranches();
      await running;

      expect(waiter.calls).toEqual([{ ...permissionWait, nodeId: "f" }]);
      expect(decision).toEqual({ behavior: "allow" });
    });

    it("files a request during the interrupt under the fork's id", async () => {
      const waiter = new FakeWaiter([approve]);
      const permissions = new FakePermissionSource();
      const h = sectionHarness({ waiter, permissions, onFork: launchAll });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      h.deps.prompts = {
        ...h.deps.prompts,
        interrupt: async () => {
          h.calls.push("interrupt");
          await released;
        },
      };
      const running = runOn(h.deps, sectionManifest({ wait: "first" }));
      await forkSent(h.calls);
      h.session.subagentStop("a1", "a1 reply");
      await vi.waitFor(() => expect(h.calls).toContain("interrupt"));

      const decision = await permissions.ask(sessionId, bash("echo hi"));
      release();
      await running;

      expect(waiter.calls).toEqual([{ ...permissionWait, nodeId: "f" }]);
      expect(decision).toEqual({ behavior: "allow" });
    });
  });

  it("does not rerun the branches after the section: one fork turn, then the next node", async () => {
    const h = sectionHarness({
      onFork: (s) => {
        for (const id of branchIds) s.launch(id);
        for (const id of branchIds) s.subagentStop(id, `${id} reply`);
        s.stop("All done.");
      },
    });

    const result = await runOn(h.deps, sectionManifest());

    expect(result.outcome).toBe("done");
    expect(sends(h.calls)).toEqual([forkSend(), afterSend]);
    for (const id of branchIds) expect(kindsOf(h.deps.store, id)).toEqual(["sent", "done"]);
  });

  it("refuses a fork with one branch before anything is sent", async () => {
    const h = sectionHarness();

    const error = await runOn(h.deps, sectionManifest({ branches: ["a1"] })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(StructureError);
    expect((error as StructureError).problems).toContainEqual(
      expect.stringMatching(/^f\b.*has 1 branches; a parallel start needs two or more\.$/),
    );
    expect(h.calls).toEqual([]);
  });

  it("fails the fork, branches and join as a resume's fail actions say, sending nothing", async () => {
    const h = sectionHarness();
    const m = sectionManifest({ branches: ["a1", "a2"] });
    const { id } = h.deps.store.createRun(newRun(m));
    for (const [nodeId, kind] of [
      ["f", "sent"],
      ["a1", "sent"],
      ["a2", "sent"],
      ["j", "running"],
    ] as const) {
      h.deps.store.append(id, nodeId, { kind });
    }
    const interrupted = (nodeId: string) =>
      `${nodeId} failed: parallel section was interrupted; Retry sends it again`;
    const actions: ResumeActions = {
      f: { kind: "fail", message: interrupted("f") },
      a1: { kind: "fail", message: interrupted("a1") },
      j: { kind: "fail", message: interrupted("j") },
    };

    const result = await new Runner({ ...h.deps, runId: id }).run(m, { actions });

    expect(sends(h.calls)).toEqual([]);
    expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
    expect(result.states).toEqual({
      f: "failed",
      a1: "failed",
      a2: "sent",
      j: "failed",
      after: "waiting",
    });
    expect(eventsOf(h.deps.store, "a1").at(-1)).toMatchObject({
      kind: "failed",
      payload: { message: interrupted("a1") },
    });
    expect(h.lines.at(-1)).toBe(interrupted("f"));
  });

  describe("retry", () => {
    type History = [string, RunEvent][];
    const failedWith = (nodeId: string, reason = "no Stop"): [string, RunEvent] => [
      nodeId,
      { kind: "failed", payload: { message: `${nodeId} failed: ${reason}` } },
    ];
    const opened: History = [
      ["f", { kind: "sent" }],
      ["a1", { kind: "sent" }],
      ["a2", { kind: "sent" }],
      ["a3", { kind: "sent" }],
      ["j", { kind: "running" }],
    ];
    const retried = (deps: TestDeps, m: RunnableManifest, history: History, target: string) => {
      const { id } = deps.store.createRun(newRun(m));
      for (const [nodeId, event] of history) deps.store.append(id, nodeId, event);
      for (const { nodeId, event } of retryEntries(
        { nodes: m.nodes, wires: m.wires ?? [] },
        deps.store.events(id),
        target,
      )) {
        deps.store.append(id, nodeId, event);
      }
      return new Runner({ ...deps, runId: id }).run(m);
    };
    const afterRetry = (store: FakeStore, nodeId: string) => {
      const kinds = kindsOf(store, nodeId);
      return kinds.slice(kinds.lastIndexOf("retry") + 1);
    };
    const finishing =
      (ids: string[], extra: Turn = () => undefined): Turn =>
      (s) => {
        extra(s);
        for (const id of ids) s.launch(id);
        for (const id of ids) s.subagentStop(id, `${id} reply`);
        s.stop("Done again.");
      };
    const a1DoneRestFailed: History = [
      ...opened,
      ["a1", { kind: "done" }],
      failedWith("a2"),
      failedWith("a3"),
      failedWith("j"),
      failedWith("f"),
    ];

    it("reruns only the failed branch, keeps the done branch's result and completes the join", async () => {
      const h = sectionHarness({ onFork: finishing(["a2"]) });
      const m = sectionManifest({ branches: ["a1", "a2"] });
      const history: History = [
        ["f", { kind: "sent" }],
        ["a1", { kind: "sent" }],
        ["a2", { kind: "sent" }],
        ["j", { kind: "running" }],
        ["a1", { kind: "done" }],
        failedWith("a2"),
        failedWith("j"),
        failedWith("f"),
      ];

      const result = await retried(h.deps, m, history, "a2");

      expect(result.outcome).toBe("done");
      expect(sends(h.calls)).toEqual([forkSend(["a2"]), afterSend]);
      expect(kindsOf(h.deps.store, "a1")).toEqual(["sent", "done"]);
      expect(afterRetry(h.deps.store, "a2")).toEqual(["sent", "done"]);
      expect(afterRetry(h.deps.store, "j")).toEqual(["running", "done"]);
      expect(afterRetry(h.deps.store, "f")).toEqual(["sent", "done"]);
      expect(result.states).toEqual({
        f: "done",
        a1: "done",
        a2: "done",
        j: "done",
        after: "done",
      });
    });

    it.each(["f", "j"])(
      "retrying %s reruns every unfinished branch and not the done one",
      async (target) => {
        const h = sectionHarness({ onFork: finishing(["a2", "a3"]) });

        const result = await retried(h.deps, sectionManifest(), a1DoneRestFailed, target);

        expect(result.outcome).toBe("done");
        expect(sends(h.calls)).toEqual([forkSend(["a2", "a3"]), afterSend]);
        expect(kindsOf(h.deps.store, "a1")).toEqual(["sent", "done"]);
        expect(result.states).toMatchObject({ f: "done", a2: "done", a3: "done", j: "done" });
      },
    );

    it("reruns the unfinished branches of a section a resume failed, keeping the done one", async () => {
      const h = sectionHarness({ onFork: finishing(["a2"]) });
      const m = sectionManifest({ branches: ["a1", "a2"] });
      const { id } = h.deps.store.createRun(newRun(m));
      for (const [nodeId, event] of [
        ["f", { kind: "sent" }],
        ["a1", { kind: "sent" }],
        ["a2", { kind: "sent" }],
        ["j", { kind: "running" }],
        ["a1", { kind: "done" }],
      ] as History) {
        h.deps.store.append(id, nodeId, event);
      }
      const interrupted = (nodeId: string) =>
        `${nodeId} failed: parallel section was interrupted; Retry sends it again`;
      const actions: ResumeActions = {
        f: { kind: "fail", message: interrupted("f") },
        a2: { kind: "fail", message: interrupted("a2") },
        j: { kind: "fail", message: interrupted("j") },
      };
      expect((await new Runner({ ...h.deps, runId: id }).run(m, { actions })).outcome).toBe(
        "failed",
      );
      for (const { nodeId, event } of retryEntries(
        { nodes: m.nodes, wires: m.wires ?? [] },
        h.deps.store.events(id),
        "f",
      )) {
        h.deps.store.append(id, nodeId, event);
      }

      const result = await new Runner({ ...h.deps, runId: id }).run(m);

      expect(result.outcome).toBe("done");
      expect(sends(h.calls)).toEqual([forkSend(["a2"]), afterSend]);
      expect(kindsOf(h.deps.store, "a1")).toEqual(["sent", "done"]);
      expect(result.states).toMatchObject({ f: "done", a1: "done", a2: "done", j: "done" });
    });

    it.each([
      ["skip", [] as History],
      [
        "wait",
        [
          ["j", { kind: "needs-you" }],
          [
            "j",
            {
              kind: "answered",
              payload: { nodeId: "j", decision: "answered", answer: "continue" },
            },
          ],
          ["j", { kind: "running" }],
        ] as History,
      ],
    ] as const)(
      "leaves a branch the %s rule skipped as skipped and does not send it",
      async (onBranchFail, answered) => {
        const h = sectionHarness({ onFork: finishing(["a2"]) });
        const history: History = [
          ...opened,
          ...answered,
          ["a3", { kind: "skipped" }],
          ["a1", { kind: "done" }],
          failedWith("a2"),
          failedWith("j"),
          failedWith("f"),
        ];

        const result = await retried(h.deps, sectionManifest({ onBranchFail }), history, "a2");

        expect(result.outcome).toBe("done");
        expect(sends(h.calls)).toEqual([forkSend(["a2"]), afterSend]);
        expect(kindsOf(h.deps.store, "a3")).toEqual(["sent", "skipped"]);
        expect(result.states).toMatchObject({ a1: "done", a2: "done", a3: "skipped", j: "done" });
      },
    );

    it("sends no fork turn when nothing is left to rerun, and completes the join and the fork", async () => {
      const h = sectionHarness();
      const history: History = [
        ...opened,
        ["a3", { kind: "skipped" }],
        ["a1", { kind: "done" }],
        ["a2", { kind: "done" }],
        failedWith("j", "settle timed out"),
        failedWith("f", "settle timed out"),
      ];

      const result = await retried(h.deps, sectionManifest({ onBranchFail: "skip" }), history, "j");

      expect(result.outcome).toBe("done");
      expect(sends(h.calls)).toEqual([afterSend]);
      expect(afterRetry(h.deps.store, "f")).toEqual(["sent", "done"]);
      expect(afterRetry(h.deps.store, "j")).toEqual(["running", "done"]);
      expect(kindsOf(h.deps.store, "a1")).toEqual(["sent", "done"]);
      expect(kindsOf(h.deps.store, "a2")).toEqual(["sent", "done"]);
      expect(kindsOf(h.deps.store, "a3")).toEqual(["sent", "skipped"]);
    });

    it("counts no turn and compacts nothing for a section completed from kept results", async () => {
      const usage = new FakeUsageSource();
      usage.setEntries(sessionId, [
        {
          messageId: "m1",
          model: "claude-opus-5-5",
          inputTokens: 0,
          outputTokens: 10,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 850_000,
        },
      ]);
      const waiter = new FakeWaiter([]);
      const h = sectionHarness({ waiter, usage, budget: 100 });
      h.deps.usageSettleMs = 50;
      h.deps.compactions = usage;
      const send = h.deps.prompts.sendPrompt;
      h.deps.prompts = {
        ...h.deps.prompts,
        sendPrompt: async (text) => {
          await send(text);
          if (text === "/compact") usage.compacted(sessionId);
        },
      };
      const history: History = [
        ...opened,
        ["a3", { kind: "skipped" }],
        ["a1", { kind: "done" }],
        ["a2", { kind: "done" }],
        failedWith("j", "settle timed out"),
        failedWith("f", "settle timed out"),
      ];

      const result = await retried(h.deps, sectionManifest({ onBranchFail: "skip" }), history, "j");

      expect(waiter.calls).toEqual([]);
      expect(result.outcome).toBe("done");
      expect(afterRetry(h.deps.store, "f")).toEqual(["sent", "done"]);
      expect(kindsOf(h.deps.store, "after")).toEqual(["compacted", "sent", "done"]);
    });

    it("waits for first: a kept done branch completes the join even when a rerun branch's input file is missing", async () => {
      const h = sectionHarness();
      const flow = builders.flow(
        [
          builders.agent("plan", { settings: { writes: ["plan.md"] } }),
          builders.fork("f"),
          builders.agent("a1"),
          builders.agent("a2", { settings: { given: ["plan.md"] } }),
          builders.join("j", { settings: { wait: "first", onBranchFail: "stop" } }),
        ],
        [
          builders.thenWire("plan", "f"),
          builders.thenWire("f", "a1"),
          builders.thenWire("f", "a2"),
          builders.thenWire("a1", "j"),
          builders.thenWire("a2", "j"),
        ],
      );
      const { nodes, wires } = lower(flow, { name: prefix, values: {} }).manifest;
      const history: History = [
        ["plan", { kind: "sent" }],
        ["plan", { kind: "done" }],
        ["f", { kind: "sent" }],
        ["a1", { kind: "sent" }],
        ["a2", { kind: "sent" }],
        ["j", { kind: "running" }],
        ["a1", { kind: "done" }],
        failedWith("a2"),
        failedWith("j"),
        failedWith("f"),
      ];

      const result = await retried(h.deps, { hash, prefix, nodes, wires }, history, "f");

      expect(h.lines).not.toContain("a2 failed: plan.md wasn't written by plan");
      expect(result.outcome).toBe("done");
      expect(sends(h.calls)).toEqual([]);
      expect(result.states).toMatchObject({ a1: "done", a2: "skipped", j: "done", f: "done" });
    });

    it("waits for first: a kept done branch completes the join, sending nothing and skipping the unfinished branches", async () => {
      const h = sectionHarness();

      const result = await retried(
        h.deps,
        sectionManifest({ wait: "first" }),
        a1DoneRestFailed,
        "f",
      );

      expect(result.outcome).toBe("done");
      expect(sends(h.calls)).toEqual([afterSend]);
      expect(h.calls).not.toContain("interrupt");
      expect(afterRetry(h.deps.store, "a2")).toEqual(["skipped"]);
      expect(afterRetry(h.deps.store, "a3")).toEqual(["skipped"]);
      expect(result.states).toEqual({
        f: "done",
        a1: "done",
        a2: "skipped",
        a3: "skipped",
        j: "done",
        after: "done",
      });
    });

    it("records nothing for a stray finished call from a kept done branch during the rerun", async () => {
      const h = sectionHarness({
        onFork: finishing(["a2", "a3"], (s) => s.subagentStop("a1", "a1 again")),
      });

      const result = await retried(h.deps, sectionManifest(), a1DoneRestFailed, "a2");

      expect(result.outcome).toBe("done");
      expect(kindsOf(h.deps.store, "a1")).toEqual(["sent", "done"]);
      expect(eventsOf(h.deps.store, "a1").at(-1)).not.toMatchObject({
        payload: { stopMessage: "a1 again" },
      });
    });

    it("fails the section again when a rerun branch never stops, leaving the kept done branch alone", async () => {
      const h = sectionHarness({
        turnTimeoutMs: 100,
        onFork: (s) => {
          s.launch("a2");
          s.launch("a3");
          s.subagentStop("a3", "a3 reply");
          s.stop("Launched.");
        },
      });

      const result = await retried(h.deps, sectionManifest(), a1DoneRestFailed, "a2");

      expect(result).toMatchObject({ outcome: "failed", failedNode: "f" });
      expect(sends(h.calls)).toEqual([forkSend(["a2", "a3"])]);
      expect(kindsOf(h.deps.store, "a1")).toEqual(["sent", "done"]);
      expect(afterRetry(h.deps.store, "a2")).toEqual(["sent", "failed"]);
      expect(afterRetry(h.deps.store, "a3")).toEqual(["sent", "done"]);
      expect(result.states).toMatchObject({ f: "failed", a1: "done", j: "failed" });
    });
  });
});

describe("Runner branch on a yes/no variable", () => {
  const runIdOf = (store: FakeStore) => store.runs[0]?.id ?? "";
  const kindsOf = (store: FakeStore, nodeId: string) =>
    store
      .events(runIdOf(store))
      .filter((event) => event.nodeId === nodeId)
      .map((event) => event.kind);
  const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
  const ran = (calls: string[]) => sends(calls).map((call) => /NODE ([^\\"]+)/.exec(call)?.[1]);
  const step = (id: string) => builders.agent(id);
  const start = (e2e: boolean) =>
    builders.trigger("start", { settings: { inputs: [], flags: { e2e } } });
  const yes = (to: string) => builders.wire("b", "yes", to, "in");
  const no = (to: string) => builders.wire("b", "no", to, "in");
  const toManifest = (
    nodes: unknown[],
    wires: unknown[],
    chosen: Record<string, boolean> = {},
  ): RunnableManifest => {
    const input = builders.flow(nodes, wires);
    const defaults = Object.fromEntries(
      input.session.buildConfig.variables.flatMap((variable) =>
        variable.default === undefined ? [] : [[variable.name, variable.default]],
      ),
    );
    const { manifest: lowered } = lower(input, {
      name: prefix,
      values: { ...defaults, ...chosen },
    });
    return {
      hash,
      prefix: lowered.prefix,
      layout: lowered.layout,
      values: lowered.values,
      nodes: lowered.nodes,
      wires: lowered.wires,
    };
  };
  const twoPathNodes = (e2e = true) => [
    start(e2e),
    builders.branch("b", "e2e"),
    step("e2e"),
    step("quick"),
    step("finish"),
  ];
  const twoPathWires = [
    builders.thenWire("start", "b"),
    yes("e2e"),
    no("quick"),
    builders.thenWire("e2e", "finish"),
    builders.thenWire("quick", "finish"),
  ];
  const twoPaths = (chosen: Record<string, boolean> = {}) =>
    toManifest(twoPathNodes(), twoPathWires, chosen);

  it("skips the yes path and runs the no path and the rejoin when the build's value is false", async () => {
    const { deps, calls, lines } = harness();

    const result = await runOn(deps, twoPaths({ e2e: false }));

    expect(result.outcome).toBe("done");
    expect(ran(calls)).toEqual(["quick", "finish"]);
    expect(kindsOf(deps.store, "e2e")).toEqual(["skipped"]);
    expect(lines).toContain("e2e skipped");
    expect(result.states).toMatchObject({
      b: "done",
      e2e: "skipped",
      quick: "done",
      finish: "done",
    });
  });

  it("runs the yes path and skips the no path when the build's value is true", async () => {
    const { deps, calls } = harness();

    const result = await runOn(deps, twoPaths({ e2e: true }));

    expect(result.outcome).toBe("done");
    expect(ran(calls)).toEqual(["e2e", "finish"]);
    expect(kindsOf(deps.store, "quick")).toEqual(["skipped"]);
    expect(result.states).toMatchObject({
      b: "done",
      e2e: "done",
      quick: "skipped",
      finish: "done",
    });
  });

  it("keeps the build's value over a run flag of the same name", async () => {
    const { deps, calls } = harness({ flags: { e2e: true } });

    const result = await runOn(deps, twoPaths({ e2e: false }));

    expect(ran(calls)).toEqual(["quick", "finish"]);
    expect(result.states).toMatchObject({ b: "done", e2e: "skipped" });
  });

  it("follows the build value for a Branch on proceed-e2e that names variable mode", async () => {
    const { deps, calls } = harness();
    const m = toManifest(
      [
        start(true),
        {
          ...builders.branch("b", ""),
          settings: { decidedBy: "variable", variable: "proceed-e2e" },
        },
        step("e2e"),
        step("quick"),
      ],
      [builders.thenWire("start", "b"), yes("e2e"), no("quick")],
      { "proceed-e2e": false },
    );

    const result = await runOn(deps, m);

    expect(result.outcome).toBe("done");
    expect(ran(calls)).toEqual(["quick"]);
    expect(result.states).toMatchObject({ b: "done", e2e: "skipped", quick: "done" });
  });

  describe("decided by a value an earlier Agent produces", () => {
    const fence = "```";
    const answering = (answer: boolean, name = "a") =>
      `Checked.\n${fence}json\n{"${name}": ${answer}}\n${fence}`;
    const producer = (id: string, name = "a") =>
      builders.agent(id, { settings: { produces: name } });
    const valueBranch = (name = "a") => ({
      ...builders.branch("b", ""),
      settings: { variable: "", decidedBy: "value", value: name },
    });
    const eventsOf = (store: FakeStore, nodeId: string) =>
      store.events(runIdOf(store)).filter((event) => event.nodeId === nodeId);
    const seeded = (deps: TestDeps, m: RunnableManifest, entries: [string, RunEvent][]) => {
      const { id } = deps.store.createRun(newRun(m));
      for (const [nodeId, event] of entries) deps.store.append(id, nodeId, event);
      return id;
    };
    const checkThenBranch = () =>
      toManifest(
        [builders.trigger("start"), producer("check"), valueBranch(), step("ship"), step("fix")],
        [
          builders.thenWire("start", "check"),
          builders.thenWire("check", "b"),
          yes("ship"),
          no("fix"),
        ],
      );
    const checkDone = (payload: DonePayload): [string, RunEvent][] => [
      ["check", { kind: "sent" }],
      ["check", { kind: "done", payload }],
    ];
    type DonePayload = NonNullable<Extract<RunEvent, { kind: "done" }>["payload"]>;
    const answered = (answer: string) => ({
      nodeId: "b",
      decision: "answered" as const,
      answer,
    });

    it("takes yes at step 8 when the Agent at step 3 answers yes, skipping no", async () => {
      const steps = ["s1", "s2", "check", "s4", "s5", "s6", "s7"];
      const m = toManifest(
        [
          builders.trigger("start"),
          ...steps.map((id) => (id === "check" ? producer(id) : step(id))),
          valueBranch(),
          step("ship"),
          step("fix"),
        ],
        [
          builders.thenWire("start", "s1"),
          ...steps.slice(1).map((id, at) => builders.thenWire(steps[at] ?? "", id)),
          builders.thenWire("s7", "b"),
          yes("ship"),
          no("fix"),
        ],
      );
      const { deps, calls } = harness({
        replies: [
          undefined,
          undefined,
          answering(true),
          undefined,
          undefined,
          undefined,
          undefined,
        ],
      });

      const result = await runOn(deps, m);

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual([...steps, "ship"]);
      expect(eventsOf(deps.store, "check").at(-1)).toMatchObject({
        kind: "done",
        payload: { produced: { name: "a", answer: true } },
      });
      expect(kindsOf(deps.store, "fix")).toEqual(["skipped"]);
      expect(result.states).toMatchObject({ b: "done", ship: "done", fix: "skipped" });
    });

    it("takes no when the producer answers no", async () => {
      const { deps, calls } = harness({ replies: [answering(false)] });

      const result = await runOn(deps, checkThenBranch());

      expect(ran(calls)).toEqual(["check", "fix"]);
      expect(result.states).toMatchObject({ b: "done", ship: "skipped", fix: "done" });
    });

    it("reads the latest answer when several Agents produce the value", async () => {
      const m = toManifest(
        [
          builders.trigger("start"),
          producer("first"),
          producer("second"),
          valueBranch(),
          step("ship"),
          step("fix"),
        ],
        [
          builders.thenWire("start", "first"),
          builders.thenWire("first", "second"),
          builders.thenWire("second", "b"),
          yes("ship"),
          no("fix"),
        ],
      );
      const { deps, calls } = harness({ replies: [answering(false), answering(true)] });

      await runOn(deps, m);

      expect(ran(calls)).toEqual(["first", "second", "ship"]);
    });

    it.each([
      ["no json block", "Checked, all good."],
      ["only a Loop's done", `${fence}json\n{"done": true}\n${fence}`],
      ["no reply", undefined],
    ])(
      "asks on the Branch, never picking a path, when the producer's reply has %s",
      async (_, reply) => {
        const waiter = new FakeWaiter([{ decision: "answer", answer: "no" }]);
        const { deps, calls } = harness({ replies: [reply], waiter });

        const result = await runOn(deps, checkThenBranch());

        expect(waiter.calls).toEqual([
          expect.objectContaining({ nodeId: "b", kind: "ask", options: ["yes", "no", "fail"] }),
        ]);
        expect(ran(calls)).toEqual(["check", "fix"]);
        expect(eventsOf(deps.store, "b").map((event) => event.kind)).toEqual(
          expect.arrayContaining(["needs-you", "answered", "done"]),
        );
        expect(result.states).toMatchObject({ b: "done", ship: "skipped", fix: "done" });
      },
    );

    it("fails the run at the Branch when the answer to its question is fail", async () => {
      const waiter = new FakeWaiter([{ decision: "answer", answer: "fail" }]);
      const { deps, calls } = harness({ replies: ["Checked."], waiter });

      const result = await runOn(deps, checkThenBranch());

      expect(result).toMatchObject({ outcome: "failed", failedNode: "b" });
      expect(ran(calls)).toEqual(["check"]);
      expect(result.states).toMatchObject({ ship: "waiting", fix: "waiting" });
    });

    it.each<[string, DonePayload]>([
      ["the producer's stored answer", { produced: { name: "a", answer: true } }],
      [
        "a producer done event stored without one, read again from its reply",
        { stopMessage: answering(true) },
      ],
    ])(
      "takes the same path on resume from %s, sending the producer no new turn",
      async (_, payload) => {
        const { deps, calls } = harness();
        const m = checkThenBranch();
        const runId = seeded(deps, m, checkDone(payload));

        const result = await new Runner({ ...deps, runId }).run(m, { actions: {} });

        expect(result.outcome).toBe("done");
        expect(ran(calls)).toEqual(["ship"]);
        expect(result.states).toMatchObject({ check: "done", ship: "done", fix: "skipped" });
      },
    );

    it("reuses the answer given at the Branch on resume, without asking again", async () => {
      const { deps, calls } = harness({ waiter: new FakeWaiter([]) });
      const m = checkThenBranch();
      const runId = seeded(deps, m, [
        ...checkDone({ stopMessage: "Checked." }),
        ["b", { kind: "needs-you" }],
        ["b", { kind: "answered", payload: answered("yes") }],
      ]);

      const result = await new Runner({ ...deps, runId }).run(m, {
        actions: { b: { kind: "reuse", decision: answered("yes") } },
      });

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["ship"]);
      expect(result.states).toMatchObject({ b: "done", ship: "done", fix: "skipped" });
    });
  });

  describe("a file two writers write", () => {
    const writer = (id: string, label: string) => ({
      ...builders.agent(id, { settings: { writes: ["plan.md"] } }),
      label,
    });
    const writtenOnOneArm = (e2e: boolean) =>
      toManifest(
        [
          start(e2e),
          builders.branch("b", "e2e"),
          writer("w1", "First"),
          writer("w2", "Second"),
          builders.agent("build", { settings: { given: ["plan.md"] } }),
        ],
        [
          builders.thenWire("start", "b"),
          yes("w1"),
          no("build"),
          builders.thenWire("w1", "w2"),
          builders.thenWire("w2", "build"),
        ],
      );
    const writtenOnEachArm = (e2e: boolean) =>
      toManifest(
        [
          start(e2e),
          builders.branch("b", "e2e"),
          writer("w1", "First"),
          writer("w2", "Second"),
          builders.agent("build", { settings: { given: ["plan.md"] } }),
        ],
        [
          builders.thenWire("start", "b"),
          yes("w1"),
          no("w2"),
          builders.thenWire("w1", "build"),
          builders.thenWire("w2", "build"),
        ],
      );

    it("names both writers when neither ran on the path taken", async () => {
      const { deps, calls, lines } = harness();

      const result = await runOn(deps, writtenOnOneArm(false));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "build" });
      expect(ran(calls)).toEqual([]);
      const failure = lines.at(-1) ?? "";
      expect(failure.startsWith("build failed: plan.md wasn't written by ")).toBe(true);
      expect(failure).toContain("First");
      expect(failure).toContain("Second");
    });

    it("names only the writer that ran on the path taken", async () => {
      const { deps, lines } = harness();

      const result = await runOn(deps, writtenOnEachArm(true));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "build" });
      expect(lines.at(-1)).toBe("build failed: plan.md wasn't written by First");
    });

    it("runs the reader once a writer has written the file", async () => {
      const files = new FakeFileSystem({ [`${cwd}/plan.md`]: "- one\n" });
      const { deps, calls } = harness({ files });

      const result = await runOn(deps, writtenOnEachArm(false));

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["w2", "build"]);
    });
  });

  describe("in a hash-named build, whose manifest has Trigger flags and no values", () => {
    const oldManifest = (e2e: boolean): RunnableManifest => ({
      hash,
      prefix: hash,
      nodes: [
        node("start", "trigger", { inputs: [], flags: { e2e } }),
        node("b", "branch", { flag: "e2e" }),
        agent("e2e"),
        agent("quick"),
        agent("finish"),
      ],
      wires: twoPathWires as NonNullable<RunnableManifest["wires"]>,
    });

    it("takes the Trigger flag's default", async () => {
      const { deps, calls } = harness();

      const result = await runOn(deps, oldManifest(true));

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["e2e", "finish"]);
    });

    it("takes the run's flag over the Trigger default", async () => {
      const { deps, calls } = harness({ flags: { e2e: false } });

      const result = await runOn(deps, oldManifest(true));

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["quick", "finish"]);
    });
  });

  it("writes the Branch's running and done and every skip in one batch", async () => {
    const { deps } = harness();
    const spy = vi.spyOn(deps.store, "appendAll");

    await runOn(
      deps,
      toManifest(
        [start(true), builders.branch("b", "e2e"), step("e2e"), step("quick"), step("lint")],
        [
          builders.thenWire("start", "b"),
          yes("e2e"),
          no("quick"),
          builders.thenWire("quick", "lint"),
        ],
      ),
    );

    const batches = spy.mock.calls.map(([, entries]) =>
      entries.map(({ nodeId, event }) => `${nodeId} ${event.kind}`),
    );
    expect(batches).toContainEqual(["b running", "b done", "quick skipped", "lint skipped"]);
    expect(kindsOf(deps.store, "b")).toEqual(["running", "done"]);
  });

  it.each([
    ["loop", builders.loop("body", { settings: { condition: "done", cap: 3, onCap: "fail" } })],
    ["for each", builders.forEach("body")],
  ])(
    "skips a %s and its body on the path not taken, and the run finishes",
    async (_, container) => {
      const { deps, calls } = harness();

      const result = await runOn(
        deps,
        toManifest(
          [
            start(true),
            builders.branch("b", "e2e"),
            step("e2e"),
            container,
            builders.agent("body-1", { parent: "body" }),
            step("finish"),
          ],
          [
            builders.thenWire("start", "b"),
            yes("e2e"),
            no("body"),
            builders.thenWire("e2e", "finish"),
            builders.thenWire("body", "finish"),
          ],
        ),
      );

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["e2e", "finish"]);
      expect(result.states).toMatchObject({ body: "skipped", "body-1": "skipped", finish: "done" });
    },
  );

  it.each([
    ["loop", builders.loop("body", { settings: { condition: "done", cap: 3, onCap: "fail" } })],
    ["for each", builders.forEach("body")],
  ])(
    "skips a %s whose body is wired straight from the path not taken, and the run finishes",
    async (_, container) => {
      const { deps, calls } = harness();

      const result = await runOn(
        deps,
        toManifest(
          [
            start(true),
            builders.branch("b", "e2e"),
            step("e2e"),
            container,
            builders.agent("fix", { parent: "body" }),
            builders.agent("check", { parent: "body" }),
            step("finish"),
          ],
          [
            builders.thenWire("start", "b"),
            yes("e2e"),
            no("fix"),
            builders.thenWire("fix", "check"),
            builders.thenWire("e2e", "finish"),
            builders.thenWire("check", "finish"),
          ],
        ),
      );

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["e2e", "finish"]);
      expect(result.states).toMatchObject({
        body: "skipped",
        fix: "skipped",
        check: "skipped",
        finish: "done",
      });
    },
  );

  it("skips a loop whose back-edge sits behind a node on the path not taken", async () => {
    const { deps, calls } = harness();

    const result = await runOn(
      deps,
      toManifest(
        [
          start(true),
          builders.branch("b", "e2e"),
          step("e2e"),
          step("prep"),
          builders.loop("review", { settings: { condition: "done", cap: 3, onCap: "fail" } }),
          builders.agent("fix", { parent: "review" }),
          builders.agent("check", { parent: "review" }),
          step("finish"),
        ],
        [
          builders.thenWire("start", "b"),
          yes("e2e"),
          no("prep"),
          builders.thenWire("prep", "fix"),
          builders.thenWire("fix", "check"),
          builders.thenWire("check", "fix"),
          builders.thenWire("e2e", "finish"),
          builders.thenWire("check", "finish"),
        ],
      ),
    );

    expect(result.outcome).toBe("done");
    expect(ran(calls)).toEqual(["e2e", "finish"]);
    expect(result.states).toMatchObject({
      prep: "skipped",
      review: "skipped",
      fix: "skipped",
      check: "skipped",
      finish: "done",
    });
  });

  it("skips a whole parallel section on the path not taken, and the run finishes", async () => {
    const { deps, calls } = harness();

    const result = await runOn(
      deps,
      toManifest(
        [
          start(true),
          builders.branch("b", "e2e"),
          step("e2e"),
          builders.fork("f"),
          builders.agent("a1"),
          builders.agent("a2"),
          builders.join("j"),
          step("finish"),
        ],
        [
          builders.thenWire("start", "b"),
          yes("e2e"),
          no("f"),
          builders.thenWire("f", "a1"),
          builders.thenWire("f", "a2"),
          builders.thenWire("a1", "j"),
          builders.thenWire("a2", "j"),
          builders.thenWire("e2e", "finish"),
          builders.thenWire("j", "finish"),
        ],
      ),
    );

    expect(result.outcome).toBe("done");
    expect(ran(calls)).toEqual(["e2e", "finish"]);
    expect(result.states).toMatchObject({
      f: "skipped",
      a1: "skipped",
      a2: "skipped",
      j: "skipped",
      finish: "done",
    });
  });

  it("skips a node fed only by paths two branches did not take", async () => {
    const { deps, calls } = harness();

    const result = await runOn(
      deps,
      toManifest(
        [
          builders.trigger("start", { settings: { inputs: [], flags: { one: true, two: true } } }),
          builders.branch("b1", "one"),
          builders.branch("b2", "two"),
          step("p"),
          step("q"),
          step("X"),
          step("end"),
        ],
        [
          builders.thenWire("start", "b1"),
          builders.wire("b1", "yes", "b2", "in"),
          builders.wire("b1", "no", "p", "in"),
          builders.wire("b2", "yes", "q", "in"),
          builders.wire("b2", "no", "X", "in"),
          builders.thenWire("p", "X"),
          builders.thenWire("q", "end"),
          builders.thenWire("X", "end"),
        ],
      ),
    );

    expect(result.outcome).toBe("done");
    expect(ran(calls)).toEqual(["q", "end"]);
    expect(result.states).toMatchObject({ p: "skipped", X: "skipped", q: "done", end: "done" });
  });

  it("runs a node after a loop nothing outside wires into, though the path not taken also leads to it", async () => {
    const fence = "```";
    const { deps, calls } = harness({
      replies: ["y done", "fix done", `ok\n${fence}json\n{"done": true}\n${fence}`],
    });

    const result = await runOn(
      deps,
      toManifest(
        [
          start(true),
          builders.branch("b", "e2e"),
          step("y"),
          builders.loop("review", { settings: { condition: "done", cap: 3, onCap: "fail" } }),
          builders.agent("fix", { parent: "review" }),
          builders.agent("check", { parent: "review" }),
          step("z"),
        ],
        [
          builders.thenWire("start", "b"),
          yes("y"),
          no("z"),
          builders.thenWire("fix", "check"),
          builders.thenWire("check", "z"),
        ],
      ),
    );

    expect(result.outcome).toBe("done");
    expect(ran(calls)).toEqual(["y", "fix", "check", "z"]);
    expect(result.states).toMatchObject({ review: "done", check: "done", z: "done" });
  });

  describe("when an earlier Branch's path not taken and the current one's meet", () => {
    const meeting = () =>
      toManifest(
        [
          builders.trigger("start", { settings: { inputs: [], flags: { one: true, two: true } } }),
          builders.branch("b1", "one"),
          builders.branch("b2", "two"),
          step("q"),
          step("Z"),
          step("end"),
        ],
        [
          builders.thenWire("start", "b1"),
          builders.wire("b1", "yes", "b2", "in"),
          builders.wire("b1", "no", "Z", "in"),
          builders.wire("b2", "yes", "q", "in"),
          builders.wire("b2", "no", "Z", "in"),
          builders.thenWire("q", "end"),
          builders.thenWire("Z", "end"),
        ],
      );

    it("skips the node both paths not taken lead to", async () => {
      const { deps, calls } = harness();

      const result = await runOn(deps, meeting());

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["q", "end"]);
      expect(result.states).toMatchObject({ Z: "skipped", q: "done", end: "done" });
    });

    it("skips it on a resume where the earlier Branch is already done", async () => {
      const { deps, calls } = harness();
      const m = meeting();
      const { id } = deps.store.createRun(newRun(m));
      deps.store.append(id, "b1", { kind: "running" });
      deps.store.append(id, "b1", { kind: "done" });

      const result = await new Runner({ ...deps, runId: id }).run(m, { actions: {} });

      expect(result.outcome).toBe("done");
      expect(ran(calls)).toEqual(["q", "end"]);
      expect(result.states).toMatchObject({ b1: "done", Z: "skipped", q: "done", end: "done" });
    });
  });
});

describe("Runner compaction", () => {
  const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
  const runIdOf = (store: FakeStore) => store.runs[0]?.id ?? "";
  const eventsOf = (store: FakeStore, nodeId: string) =>
    store.events(runIdOf(store)).filter((event) => event.nodeId === nodeId);
  const used = (messageId: string, cacheReadTokens: number): UsageEntry[] => [
    {
      messageId,
      model: "claude-opus-5-5",
      inputTokens: 0,
      outputTokens: 10,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens,
    },
  ];
  const three = manifest(agent("n1"), agent("n2"), agent("n3"));

  function filling(tokensAfterFirst: number, options: { compactDone?: boolean } = {}) {
    const usage = new FakeUsageSource();
    const h = harness({ usage });
    const send = h.deps.prompts.sendPrompt;
    let turns = 0;
    h.deps.prompts = {
      interrupt: async () => undefined,
      sendPrompt: async (text) => {
        if (text === "/compact") {
          h.calls.push(`send ${text}`);
          if (options.compactDone !== false) usage.compacted(sessionId);
          return;
        }
        await send(text);
        turns++;
        usage.setEntries(sessionId, used(`m${turns}`, turns === 1 ? tokensAfterFirst : 1_000));
      },
    };
    h.deps.compactions = usage;
    return { ...h, usage };
  }

  it("sends /compact once between nodes when the context passes 80%, then the next node", async () => {
    const { deps, calls, lines } = filling(850_000);

    const result = await runOn(deps, three);

    expect(result.outcome).toBe("done");
    expect(sends(calls)).toEqual([turnOf("n1"), "send /compact", turnOf("n2"), turnOf("n3")]);
    expect(eventsOf(deps.store, "n2")).toMatchObject([
      { kind: "compacted", payload: { tokens: 850_000 } },
      { kind: "sent" },
      { kind: "done" },
    ]);
    expect(lines).toContain("n2 compacting context at 850000 tokens");
  });

  it("does not compact while the context is under 80%", async () => {
    const { deps, calls } = filling(799_999);

    await runOn(deps, three);

    expect(sends(calls)).not.toContain("send /compact");
  });

  it("does not compact again on the same reading before a new turn lands", async () => {
    const usage = new FakeUsageSource();
    const h = harness({ usage });
    h.deps.compactions = usage;
    usage.setEntries(sessionId, used("m0", 900_000));
    const send = h.deps.prompts.sendPrompt;
    h.deps.prompts = {
      interrupt: async () => undefined,
      sendPrompt: async (text) => {
        if (text === "/compact") usage.compacted(sessionId);
        await send(text);
      },
    };

    await runOn(h.deps, three);

    expect(sends(h.calls).filter((call) => call === "send /compact")).toHaveLength(1);
  });

  it("never compacts a node it resumes in the middle of its turn", async () => {
    const { deps, calls, events, usage } = filling(850_000);
    deps.store.createRun(newRun(three));
    const runId = runIdOf(deps.store);
    deps.store.append(runId, "n1", { kind: "sent" });
    usage.setEntries(sessionId, used("m9", 900_000));

    const running = new Runner({ ...deps, runId }).run(three, {
      actions: { n1: { kind: "wait" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sends(calls)).toEqual([]);
    events.publish({ kind: "Stop", sessionId, payload: {} });
    await running;

    expect(sends(calls)[0]).toBe("send /compact");
    expect(eventsOf(deps.store, "n1").map((event) => event.kind)).toEqual(["sent", "done"]);
  });

  it("goes on to the next node, saying so, when compaction does not finish in time", async () => {
    const { deps, calls, lines } = filling(850_000, { compactDone: false });
    deps.turnTimeoutMs = 300;

    const result = await runOn(deps, three);

    expect(result.outcome).toBe("done");
    expect(sends(calls).filter((call) => call === "send /compact")).toHaveLength(1);
    expect(eventsOf(deps.store, "n2").map((event) => event.kind)).toEqual(["sent", "done"]);
    expect(lines).toContain("n2 context compaction did not finish within 300 ms; going on");
  });

  it("never reads the context without a compaction reader", async () => {
    const usage = new FakeUsageSource();
    const { deps } = harness({ usage });

    await runOn(deps, three);

    expect(usage.calls).toEqual([]);
  });
});

describe("Runner hand-off pairs", () => {
  const plan = `${cwd}/plan.md`;
  const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
  const planner = node("plan", "agent", { instructions: "Write plan.md.", writes: ["plan.md"] });
  const labelled = { ...planner, label: "Planner" };
  const builder = (id: string, given = ["plan.md"]) =>
    node(id, "agent", { instructions: "Build it.", given });
  const afterPlanner = (calls: string[]) =>
    sends(calls).filter((call) => !call.includes('the prompt "NODE plan'));
  const consumerTurn = (id: string) =>
    `send ${agentTurnText(prefix, id, { id, given: ["plan.md"], writes: [] })}`;
  const handoff = (consumer: ManifestNode, ...rest: ManifestNode[]): RunnableManifest => ({
    hash,
    prefix,
    nodes: [labelled, consumer, ...rest],
    wires: [
      { kind: "then", from: { node: "plan", port: "out" }, to: { node: consumer.id, port: "in" } },
    ],
  });

  it("starts the reader once the file its writer writes is in the working folder", async () => {
    const { deps, calls } = harness({ files: new FakeFileSystem({ [plan]: "- one\n" }) });

    const result = await runOn(deps, handoff(builder("build")));

    expect(result.outcome).toBe("done");
    expect(afterPlanner(calls)).toEqual([consumerTurn("build")]);
  });

  it("sees a file the producer wrote during its own step", async () => {
    const files = new FakeFileSystem();
    const { deps, calls } = harness({ files });
    const writing: TestDeps = {
      ...deps,
      prompts: {
        ...deps.prompts,
        sendPrompt: async (text) => {
          if (text.includes('the prompt "NODE plan')) await files.writeFile(plan, "- one\n");
          await deps.prompts.sendPrompt(text);
        },
      },
    };

    const result = await runOn(writing, handoff(builder("build")));

    expect(result.outcome).toBe("done");
    expect(afterPlanner(calls)).toEqual([consumerTurn("build")]);
  });

  it("fails the reader, naming the file and its writer, when the file was not written", async () => {
    const { deps, calls, lines } = harness();

    const result = await runOn(deps, handoff(builder("build"), agent("after")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "build" });
    expect(result.states).toEqual({ plan: "done", build: "failed", after: "waiting" });
    expect(lines.at(-1)).toBe("build failed: plan.md wasn't written by Planner");
    expect(afterPlanner(calls)).toEqual([]);
  });

  it("runs a reader given a file no other node writes, without holding it", async () => {
    const { deps, calls } = harness();
    const m: RunnableManifest = { hash, prefix, nodes: [builder("build", ["README.md"])] };

    const result = await runOn(deps, m);

    expect(result.outcome).toBe("done");
    expect(sends(calls)).toHaveLength(1);
  });

  it("does not hold a For each, which is no reader, on the file it reads", async () => {
    const { deps, lines } = harness();

    const result = await runOn(deps, handoff(forEach("e1"), inEach(agent("p1"))));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "e1" });
    expect(lines.at(-1)).not.toContain("wasn't written by");
  });

  it("checks again in every round of a For each body", async () => {
    const files = new FakeFileSystem({ [plan]: "- one\n- two\n" });
    const { deps, calls } = harness({ files });
    let round = 0;
    const deleting: TestDeps = {
      ...deps,
      prompts: {
        ...deps.prompts,
        sendPrompt: async (text) => {
          round++;
          if (round === 1) await files.remove(`${cwd}/notes.md`);
          await deps.prompts.sendPrompt(text);
        },
      },
    };
    await files.writeFile(`${cwd}/notes.md`, "x");
    const m: RunnableManifest = {
      hash,
      prefix,
      nodes: [
        forEach("e1"),
        inEach(node("p1", "agent", { instructions: "Write notes.md.", writes: ["notes.md"] })),
        inEach(builder("s1", ["notes.md"])),
      ],
    };

    const result = await runOn(deleting, m);

    expect(result).toMatchObject({ outcome: "failed", failedNode: "s1" });
    expect(sends(calls)).toHaveLength(1);
  });

  it("does not check a node that already finished before a resume", async () => {
    const { deps, calls } = harness();
    const m = handoff(builder("build"));
    const { id } = deps.store.createRun(newRun(m));
    deps.store.append(id, "plan", { kind: "sent" });
    deps.store.append(id, "plan", { kind: "done" });
    deps.store.append(id, "build", { kind: "sent" });
    deps.store.append(id, "build", { kind: "done" });

    const result = await new Runner({ ...deps, runId: id }).run(m);

    expect(result.outcome).toBe("done");
    expect(sends(calls)).toEqual([]);
  });

  it("fails a parallel section before sending it when a branch's file is missing", async () => {
    const { deps, calls, lines } = harness();
    const flow = builders.flow(
      [
        { ...builders.agent("plan", { settings: { writes: ["plan.md"] } }), label: "Planner" },
        builders.fork("f"),
        builders.agent("a1"),
        builders.agent("a2", { settings: { given: ["plan.md"] } }),
        builders.join("j"),
      ],
      [
        builders.thenWire("plan", "f"),
        builders.thenWire("f", "a1"),
        builders.thenWire("f", "a2"),
        builders.thenWire("a1", "j"),
        builders.thenWire("a2", "j"),
      ],
    );
    const { nodes, wires } = lower(flow, { name: prefix, values: {} }).manifest;

    const result = await runOn(deps, { hash, prefix, nodes, wires });

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a2" });
    expect(lines.at(-1)).toBe("a2 failed: plan.md wasn't written by Planner");
    expect(afterPlanner(calls)).toEqual([]);
  });
});

describe("Runner hand-off templates", () => {
  const workspace = "/fd/workspaces/w1";
  const worktree = `${workspace}/repo`;
  const template = `${workspace}/plugin/templates/notes.md`;
  const notes = `${worktree}/notes.md`;
  const templateText = "@template notes.md: the writing node replaces this template.\n";
  const handoff: RunnableManifest = {
    hash,
    prefix,
    nodes: [
      node("write", "agent", { instructions: "Write notes.md.", writes: ["notes.md"] }),
      node("read", "agent", { instructions: "Read notes.md.", given: ["notes.md"] }),
    ],
    wires: [
      { kind: "then", from: { node: "write", port: "out" }, to: { node: "read", port: "in" } },
    ],
  };
  const contentOf = async (files: FakeFileSystem, path: string) =>
    files.readFile(path).catch(() => undefined);
  const writerTurn = agentTurnText(prefix, "write", {
    id: "write",
    given: [],
    writes: ["notes.md"],
  });
  const writes = (files: FakeFileSystem) => files.calls.filter((c) => c.method === "writeFile");
  const inWorktree = (files: FakeFileSystem, written?: string) => {
    const { deps, lines } = harness({ files });
    const atSend: Record<string, string | undefined> = {};
    const copied: unknown[] = [];
    const tracked: TestDeps = {
      ...deps,
      cwd: worktree,
      prompts: {
        ...deps.prompts,
        sendPrompt: async (text) => {
          atSend[text] = await contentOf(files, notes);
          if (text === writerTurn) {
            copied.push(...writes(files));
            if (written !== undefined) await files.writeFile(notes, written);
          }
          await deps.prompts.sendPrompt(text);
        },
      },
    };
    return { deps: tracked, atSend, copied, lines };
  };

  it("writes the template into the worktree before the writing node runs, when the file is absent", async () => {
    const files = new FakeFileSystem({ [template]: templateText });
    const { deps, atSend, copied } = inWorktree(files, "filled");

    const result = await runOn(deps, handoff);

    expect(atSend[writerTurn]).toBe(templateText);
    expect(copied).toEqual([{ method: "writeFile", path: notes }]);
    expect(result.outcome).toBe("done");
  });

  it("fails the reading node when the writer leaves the template untouched", async () => {
    const files = new FakeFileSystem({ [template]: templateText });
    const { deps, lines } = inWorktree(files);

    const result = await runOn(deps, handoff);

    expect(result).toMatchObject({ outcome: "failed", failedNode: "read" });
    expect(lines.at(-1)).toBe("read failed: notes.md wasn't written by write");
  });

  it("passes on to the reading node when a build with no templates has the file written", async () => {
    const files = new FakeFileSystem();
    const { deps, copied } = inWorktree(files, "filled");

    const result = await runOn(deps, handoff);

    expect(copied).toEqual([]);
    expect(result.outcome).toBe("done");
  });

  it("leaves a file already in the worktree untouched", async () => {
    const files = new FakeFileSystem({ [template]: templateText, [notes]: "mine" });
    const { deps, atSend } = inWorktree(files);

    await runOn(deps, handoff);

    expect(atSend[writerTurn]).toBe("mine");
    expect(await contentOf(files, notes)).toBe("mine");
    expect(writes(files)).toEqual([]);
  });

  it("copies nothing for a build with no templates", async () => {
    const files = new FakeFileSystem();
    const { deps, atSend } = inWorktree(files);

    await runOn(deps, handoff);

    expect(atSend[writerTurn]).toBeUndefined();
    expect(writes(files)).toEqual([]);
  });
});

describe("Runner non-markdown hand-off files", () => {
  const workspace = "/fd/workspaces/w1";
  const worktree = `${workspace}/repo`;
  const template = `${workspace}/plugin/templates/greeting.txt`;
  const greeting = `${worktree}/greeting.txt`;
  const strayText = "@template greeting.txt: the writing node replaces this template.\n";
  const handoff: RunnableManifest = {
    hash,
    prefix,
    nodes: [
      node("write", "agent", { instructions: "Write greeting.txt.", writes: ["greeting.txt"] }),
      node("read", "agent", { instructions: "Read greeting.txt.", given: ["greeting.txt"] }),
    ],
    wires: [
      { kind: "then", from: { node: "write", port: "out" }, to: { node: "read", port: "in" } },
    ],
  };
  const writerTurn = agentTurnText(prefix, "write", {
    id: "write",
    given: [],
    writes: ["greeting.txt"],
  });
  const inWorktree = (files: FakeFileSystem, written?: string) => {
    const { deps } = harness({ files });
    const tracked: TestDeps = {
      ...deps,
      cwd: worktree,
      prompts: {
        ...deps.prompts,
        sendPrompt: async (text) => {
          if (text === writerTurn && written !== undefined)
            await files.writeFile(greeting, written);
          await deps.prompts.sendPrompt(text);
        },
      },
    };
    return tracked;
  };

  it("copies no template into the worktree for a file that is not markdown", async () => {
    const files = new FakeFileSystem({ [template]: strayText });

    await runOn(inWorktree(files), handoff);

    expect(await files.readFile(greeting).catch(() => undefined)).toBeUndefined();
  });

  it("takes a non-markdown file as written even when it matches a template file", async () => {
    const files = new FakeFileSystem({ [template]: strayText });

    const result = await runOn(inWorktree(files, strayText), handoff);

    expect(result.outcome).toBe("done");
  });

  it("still fails the reading node when the non-markdown file was never written", async () => {
    const files = new FakeFileSystem();

    const result = await runOn(inWorktree(files), handoff);

    expect(result).toMatchObject({ outcome: "failed", failedNode: "read" });
  });
});

describe("Runner turn names", () => {
  it("sends agents under the build's prefix, not its hash", async () => {
    const { deps, calls } = turnHarness([
      [agentDone("p1", "fix-login:p1"), stopped],
      [agentDone("a1", "fix-login:a1"), stopped],
    ]);

    const result = await runOn(deps, manifest(agent("p1"), agent("a1")));

    expect(result.outcome).toBe("done");
    expect(calls).toEqual([
      "start",
      `send ${agentTurnText("fix-login", "p1", bare("p1"))}`,
      `send ${agentTurnText("fix-login", "a1", bare("a1"))}`,
    ]);
  });

  it("keeps a hash-named build's old names when its prefix is its hash", async () => {
    const { deps, calls } = turnHarness([
      [agentDone("p1", `${hash}:p1`), stopped],
      [agentDone("a1", `${hash}:a1`), stopped],
    ]);

    const result = await runOn(deps, { hash, prefix: hash, nodes: [agent("p1"), agent("a1")] });

    expect(result.outcome).toBe("done");
    expect(calls).toEqual([
      "start",
      `send ${agentTurnText(hash, "p1", bare("p1"))}`,
      `send ${agentTurnText(hash, "a1", bare("a1"))}`,
    ]);
  });
});

describe("Runner by node", () => {
  const review = `${prefix}:review`;
  const plan = `${prefix}:plan`;
  const pieceNode = (
    id: string,
    type: "agent",
    piece: string,
    settings: Record<string, unknown> = {},
  ): ManifestNode => ({ ...node(id, type, settings), piece });
  const reviewer = (id: string, given: string[], writes: string[] = []) =>
    pieceNode(id, "agent", "review", { instructions: "Review it.", given, writes });
  const thenWire = (from: string, to: string) => ({
    kind: "then" as const,
    from: { node: from, port: "out" },
    to: { node: to, port: "in" },
  });
  const sharedManifest: RunnableManifest = {
    hash,
    prefix,
    nodes: [
      pieceNode("p1", "agent", "plan"),
      reviewer("a1", ["spec.md"], ["notes.md"]),
      reviewer("a2", ["notes.md"]),
    ],
  };
  const a1Turn = agentTurnText(prefix, "review", {
    id: "a1",
    given: ["spec.md"],
    writes: ["notes.md"],
  });
  const a2Turn = agentTurnText(prefix, "review", { id: "a2", given: ["notes.md"], writes: [] });
  const runEvents = (store: FakeStore) => store.events(store.runs[0]?.id ?? "");
  const notesWritten = () => new FakeFileSystem({ [`${cwd}/notes.md`]: "notes" });
  const sharedHarness = (turns: Emitted[][], turnTimeoutMs = 1000) =>
    turnHarness(turns, turnTimeoutMs, undefined, notesWritten());

  describe("AT-10: two Agent nodes on one piece, in sequence", () => {
    it("sends each node's own marker and details, and marks each done on its own call", async () => {
      const { deps, calls, lines } = sharedHarness([
        [agentDone("p1", plan), stopped],
        [agentDone("a1", review), stopped],
        [agentDone("a2", review), stopped],
      ]);

      const result = await runOn(deps, sharedManifest);

      expect(result).toEqual({
        outcome: "done",
        states: { p1: "done", a1: "done", a2: "done" },
        decisions: [],
      });
      expect(calls).toEqual([
        "start",
        `send ${agentTurnText(prefix, "plan", bare("p1"))}`,
        `send ${a1Turn}`,
        `send ${a2Turn}`,
      ]);
      expect(lines).toEqual([
        "p1 started",
        "p1 done",
        "a1 started",
        "a1 done",
        "a2 started",
        "a2 done",
      ]);
    });

    it("leaves a2 undone when only a1's call finishes in a2's turn", async () => {
      const { deps, lines } = sharedHarness([
        [agentDone("p1", plan), stopped],
        [agentDone("a1", review), stopped],
        [agentDone("a1", review), stopped],
      ]);

      const result = await runOn(deps, sharedManifest);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a2" });
      expect(result.states).toEqual({ p1: "done", a1: "done", a2: "failed" });
      expect(lines.at(-1)).toBe("a2 failed: no finished Agent call for a2");
    });

    it("keeps a2 pending when a1's call finishes", async () => {
      const { deps } = sharedHarness([
        [agentDone("p1", plan), stopped],
        [agentDone("a1", review), stopped],
      ]);

      const result = await runOn({ ...deps, turnTimeoutMs: 20 }, sharedManifest);

      expect(result.states).toMatchObject({ a1: "done", a2: "failed" });
      const a2Events = runEvents(deps.store).filter((event) => event.nodeId === "a2");
      expect(a2Events.map((event) => event.kind)).toEqual(["sent", "failed"]);
    });

    it("puts the finished call's id on each agent node's done event", async () => {
      const { deps } = sharedHarness([
        [agentDone("p1", plan), stopped],
        [agentDone("a1", review), stopped],
        [agentDone("a2", review), stopped],
      ]);

      await runOn(deps, sharedManifest);

      const doneOf = (nodeId: string) =>
        runEvents(deps.store).find((event) => event.nodeId === nodeId && event.kind === "done");
      expect(doneOf("a1")).toMatchObject({ payload: { toolUseIds: ["toolu-a1"] } });
      expect(doneOf("a2")).toMatchObject({ payload: { toolUseIds: ["toolu-a2"] } });
    });
  });

  it("AT-17: names every sent piece <prefix>:<piece>, never a bare piece", async () => {
    const { deps, calls } = sharedHarness([
      [agentDone("p1", plan), stopped],
      [agentDone("a1", review), stopped],
      [agentDone("a2", review), stopped],
    ]);

    await runOn(deps, sharedManifest);

    const sent = calls.filter((call) => call.startsWith("send "));
    expect(sent).toHaveLength(3);
    for (const call of sent) {
      expect(call).not.toMatch(/subagent_type "(plan|review)"/);
    }
    expect(sent[0]).toContain(`subagent_type "${plan}"`);
    expect(sent.slice(1).every((call) => call.includes(`subagent_type "${review}"`))).toBe(true);
  });

  it("AT-19: runs a build that named no pieces under <prefix>:<node id>", async () => {
    const { deps, calls } = turnHarness([
      [agentDone("p1"), stopped],
      [agentDone("a1"), stopped],
    ]);

    const result = await runOn(deps, manifest(agent("p1"), agent("a1")));

    expect(result.outcome).toBe("done");
    expect(calls).toEqual([
      "start",
      turnOf("p1"),
      `send ${agentTurnText(prefix, "a1", bare("a1"))}`,
    ]);
    expect(calls[2]).toContain(`subagent_type "${prefix}:a1"`);
  });

  describe("AT-11: two parallel branches on one piece", () => {
    const quietMs = 30;
    const sectionManifest: RunnableManifest = {
      hash,
      prefix,
      nodes: [
        node("f", "fork"),
        reviewer("b1", ["a.md"]),
        reviewer("b2", ["b.md"]),
        node("j", "join", { wait: "all", onBranchFail: "stop" }),
        agent("after"),
      ],
      wires: [
        thenWire("f", "b1"),
        thenWire("f", "b2"),
        thenWire("b1", "j"),
        thenWire("b2", "j"),
        thenWire("j", "after"),
      ],
    };

    function sharedSection(order: readonly string[], launched: readonly string[] = ["b1", "b2"]) {
      const events = new FakeEventSource();
      const calls: string[] = [];
      let clock = 1000;
      const publish = (kind: "Stop" | "PreToolUse" | "PostToolUse", payload: object) =>
        events.publish({ kind, sessionId, payload: { ...payload, flowdeck_hook_at: ++clock } });
      const deps: TestDeps & { settleQuietMs: number } = {
        store: new FakeStore(),
        prompts: {
          sendPrompt: async (text) => {
            calls.push(`send ${text}`);
            if (text.startsWith("Use the Agent tool once for each")) {
              for (const id of launched) {
                publish("PreToolUse", {
                  tool_name: "Agent",
                  tool_input: { subagent_type: review, prompt: `NODE ${id}\nGo` },
                  tool_use_id: `toolu-${id}`,
                });
              }
              publish("Stop", { last_assistant_message: "Launched." });
              setTimeout(() => {
                for (const id of order) publish("PostToolUse", agentDonePayload(id, review, id));
                publish("Stop", { last_assistant_message: "Both done." });
              }, 0);
            } else {
              publish("PostToolUse", agentDonePayload("after"));
              publish("Stop", { last_assistant_message: "OK" });
            }
          },
          interrupt: async () => undefined,
        },
        session: { ensureStarted: async () => undefined },
        events,
        waiter: new FakeWaiter([]),
        files: new FakeFileSystem(),
        cwd,
        sessionId,
        turnTimeoutMs: 500,
        now: () => clock,
        settleQuietMs: quietMs,
      };
      return { deps, calls };
    }

    it.each([[["b2", "b1"]], [["b1", "b2"]]])(
      "asks for one call per branch and marks each done on its own call, finishing %j",
      async (order) => {
        const { deps, calls } = sharedSection(order);

        const result = await runOn(deps, sectionManifest);

        expect(result.outcome).toBe("done");
        expect(result.states).toMatchObject({ b1: "done", b2: "done", j: "done", after: "done" });
        expect(calls[0]).toBe(
          `send ${forkTurnText(prefix, [
            { id: "b1", piece: "review", given: ["a.md"], writes: [] },
            { id: "b2", piece: "review", given: ["b.md"], writes: [] },
          ])}`,
        );
        const events = runEvents(deps.store);
        const doneOf = (nodeId: string) =>
          events.find((event) => event.nodeId === nodeId && event.kind === "done");
        expect(doneOf("b1")).toMatchObject({
          payload: { stopMessage: "b1", toolUseIds: ["toolu-b1"] },
        });
        expect(doneOf("b2")).toMatchObject({
          payload: { stopMessage: "b2", toolUseIds: ["toolu-b2"] },
        });
        const joinDone = events.findIndex((event) => event.nodeId === "j" && event.kind === "done");
        const branchDones = ["b1", "b2"].map((id) =>
          events.findIndex((event) => event.nodeId === id && event.kind === "done"),
        );
        expect(Math.max(...branchDones)).toBeLessThan(joinDone);
      },
    );

    it("retrying the failed branch reruns only that one, though both share the piece", async () => {
      const { deps, calls } = sharedSection(["b2"], ["b2"]);
      const { id } = deps.store.createRun(newRun(sectionManifest));
      for (const [nodeId, event] of [
        ["f", { kind: "sent" }],
        ["b1", { kind: "sent" }],
        ["b2", { kind: "sent" }],
        ["j", { kind: "running" }],
        ["b1", { kind: "done", payload: { stopMessage: "b1", toolUseIds: ["toolu-b1"] } }],
        ["b2", { kind: "failed", payload: { message: "b2 failed: no Stop" } }],
        ["j", { kind: "failed", payload: { message: "j failed: no Stop" } }],
        ["f", { kind: "failed", payload: { message: "f failed: no Stop" } }],
      ] as [string, RunEvent][]) {
        deps.store.append(id, nodeId, event);
      }
      for (const { nodeId, event } of retryEntries(
        { nodes: sectionManifest.nodes, wires: sectionManifest.wires ?? [] },
        deps.store.events(id),
        "b2",
      )) {
        deps.store.append(id, nodeId, event);
      }

      const result = await new Runner({ ...deps, runId: id }).run(sectionManifest);

      expect(result.outcome).toBe("done");
      expect(calls[0]).toBe(
        `send ${forkTurnText(prefix, [{ id: "b2", piece: "review", given: ["b.md"], writes: [] }])}`,
      );
      expect(
        runEvents(deps.store)
          .filter((event) => event.nodeId === "b1")
          .map((event) => event.kind),
      ).toEqual(["sent", "done"]);
      expect(result.states).toMatchObject({ b1: "done", b2: "done", j: "done", after: "done" });
    });
  });
});
