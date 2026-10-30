import { describe, expect, it, vi } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import { agentTurnText } from "../../../src/core/nodes/agent/execute.js";
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
import { decisionsOf, nodeStatus, type RunEvent } from "../../../src/core/run/run-events.js";
import type { ProcessResult } from "../../../src/ports/process-runner.js";
import type { UsageEntry } from "../../../src/ports/usage-source.js";
import type { WaitReply, WaitRequest } from "../../../src/ports/waiter.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeProcessRunner } from "../../fakes/fake-process-runner.js";
import { FakeUsageSource } from "../../fakes/fake-usage-source.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { budget as budgetWait, permission as permissionWait } from "../../fixtures/waits.js";

const hash = "abc123";
const sessionId = "s1";
const cwd = "/repo";

const node = (id: string, type: ManifestNode["type"], settings: Record<string, unknown> = {}) =>
  ({ id, type, label: id, settings }) as ManifestNode;
const prompt = (id: string) => node(id, "prompt", { instructions: "Do it." });
const script = (id: string, settings: Record<string, unknown> = { command: "npm" }) =>
  node(id, "script", settings);
const manifest = (...nodes: ManifestNode[]): RunnableManifest => ({ hash, nodes });
const exit = (code: number | null, stdout = "", stderr = ""): ProcessResult => ({
  code,
  stdout,
  stderr,
});

type TestDeps = Omit<RunnerDeps, "runId"> & { store: FakeStore };

const newRun = (m: RunnableManifest) => ({
  buildDir: "/fd/builds/abc",
  inputs: {},
  nodeIds: m.nodes.map((each) => each.id),
  session: { tmuxName: "fd-run", cwd, claudeSessionId: sessionId },
});

function runOn(deps: TestDeps, m: RunnableManifest, options?: RunOptions) {
  const { id } = deps.store.createRun(newRun(m));
  return new Runner({ ...deps, runId: id }).run(m, options);
}

type StopTiming = "during-send" | "after-send" | "never";

function harness(
  options: {
    results?: (ProcessResult | Error)[];
    stop?: StopTiming;
    waiter?: FakeWaiter;
    auto?: boolean;
    replies?: (string | undefined)[];
    permissions?: FakePermissionSource;
    usage?: FakeUsageSource;
    budget?: number;
  } = {},
) {
  const events = new FakeEventSource();
  const scripts = new FakeProcessRunner(options.results ?? []);
  const calls: string[] = [];
  const lines: string[] = [];
  const stop = options.stop ?? "after-send";
  let stops = 0;
  const publishStop = () => {
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
      sendPrompt: async (text) => {
        calls.push(`send ${text}`);
        if (stop === "during-send") publishStop();
        if (stop === "after-send") setTimeout(publishStop, 0);
      },
    },
    session: {
      ensureStarted: async () => {
        calls.push("start");
      },
    },
    events,
    scripts,
    waiter: options.waiter ?? new FakeWaiter([]),
    ...(options.auto === undefined ? {} : { auto: options.auto }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    onChange: (line) => lines.push(line),
    cwd,
    sessionId,
    turnTimeoutMs: 1000,
  };
  return { deps, events, scripts, calls, lines };
}

type Emitted =
  { kind: "Stop"; reply?: string } | { kind: "SubagentStop"; agentType: string; reply?: string };

const stopped: Emitted = { kind: "Stop" };
const subagentStopped = (agentType: string): Emitted => ({ kind: "SubagentStop", agentType });
const agent = (id: string) => node(id, "agent", { instructions: "Write notes.md." });

function turnHarness(turns: Emitted[][], turnTimeoutMs = 1000, waiter = new FakeWaiter([])) {
  const events = new FakeEventSource();
  const calls: string[] = [];
  const lines: string[] = [];
  let sent = 0;
  const deps: TestDeps = {
    store: new FakeStore(),
    prompts: {
      sendPrompt: async (text) => {
        calls.push(`send ${text}`);
        for (const event of turns[sent++] ?? []) {
          events.publish({
            kind: event.kind,
            sessionId,
            payload: {
              ...(event.kind === "SubagentStop" ? { agent_type: event.agentType } : {}),
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
    scripts: new FakeProcessRunner([]),
    waiter,
    onChange: (line) => lines.push(line),
    cwd,
    sessionId,
    turnTimeoutMs,
  };
  return { deps, calls, lines };
}

describe("Runner", () => {
  it("sends each of three prompts exactly once, in manifest order", async () => {
    const { deps, calls } = harness();

    const result = await runOn(deps, manifest(prompt("a"), prompt("b"), prompt("c")));

    expect(result.outcome).toBe("done");
    expect(calls.filter((call) => call.startsWith("send"))).toEqual([
      `send /${hash}:a`,
      `send /${hash}:b`,
      `send /${hash}:c`,
    ]);
    expect(result.states).toEqual({ a: "done", b: "done", c: "done" });
  });

  it("arms the turn wait before sending, so a Stop during the send is not missed", async () => {
    const { deps } = harness({ stop: "during-send" });

    const result = await runOn(deps, manifest(prompt("a")));

    expect(result.outcome).toBe("done");
    expect(result.states).toEqual({ a: "done" });
  });

  it("fails a prompt whose turn never ends and sends nothing after it", async () => {
    const { deps, calls, lines } = harness({ stop: "never" });

    const result = await runOn({ ...deps, turnTimeoutMs: 20 }, manifest(prompt("a"), prompt("b")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(result.states).toEqual({ a: "failed", b: "waiting" });
    expect(calls).toEqual(["start", `send /${hash}:a`]);
    expect(lines.at(-1)).toMatch(/^a failed: .*no Stop for session s1 within 20 ms/);
  });

  describe("script exit codes", () => {
    const run = async (results: (ProcessResult | Error)[]) => {
      const h = harness({ results });
      const result = await runOn(h.deps, manifest(script("s"), prompt("next")));
      const nextRan = h.calls.includes(`send /${hash}:next`);
      return { ...h, result, nextRan };
    };

    it("moves on after exit 0", async () => {
      const { result, scripts, nextRan } = await run([exit(0)]);

      expect(result.outcome).toBe("done");
      expect(scripts.calls).toHaveLength(1);
      expect(nextRan).toBe(true);
    });

    it("runs again once after exit 2, then moves on after exit 0", async () => {
      const { result, scripts, nextRan, lines } = await run([exit(2), exit(0)]);

      expect(result.outcome).toBe("done");
      expect(scripts.calls).toHaveLength(2);
      expect(nextRan).toBe(true);
      expect(lines.slice(0, 3)).toEqual(["s started", "s retry", "s done"]);
    });

    it("fails after exit 2 twice, running the script exactly twice", async () => {
      const { result, scripts, nextRan, lines } = await run([exit(2), exit(2), exit(0)]);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "s" });
      expect(scripts.calls).toHaveLength(2);
      expect(nextRan).toBe(false);
      expect(lines.at(-1)).toBe("s failed: exit code 2");
    });

    it("stops the run at exit 1", async () => {
      const { result, nextRan, lines } = await run([exit(1)]);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "s" });
      expect(result.states).toEqual({ s: "failed", next: "waiting" });
      expect(nextRan).toBe(false);
      expect(lines).toEqual(["s started", "s failed: exit code 1"]);
    });

    it("fails a script killed by a signal", async () => {
      const { result, nextRan, lines } = await run([exit(null)]);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "s" });
      expect(nextRan).toBe(false);
      expect(lines.at(-1)).toBe("s failed: killed by a signal");
    });

    it("fails a script that cannot be started, with the error as reason", async () => {
      const error = Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" });
      const { result, nextRan, lines } = await run([error]);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "s" });
      expect(nextRan).toBe(false);
      expect(lines.at(-1)).toBe("s failed: spawn nope ENOENT");
    });

    it("runs the command with its args, or none, in the run's folder", async () => {
      const { deps, scripts } = harness({ results: [exit(0), exit(0)] });

      await runOn(
        deps,
        manifest(script("a", { command: "npm", args: ["test"] }), script("b", { command: "ls" })),
      );

      expect(scripts.calls).toEqual([
        { command: "npm", args: ["test"], cwd },
        { command: "ls", args: [], cwd },
      ]);
    });
  });

  describe("agent nodes", () => {
    const a1Type = `${hash}:a1`;

    it("is done when its SubagentStop and then Stop arrive during the send", async () => {
      const { deps, calls, lines } = turnHarness([[subagentStopped(a1Type), stopped]]);

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toEqual({ outcome: "done", states: { a1: "done" }, decisions: [] });
      expect(calls).toEqual(["start", `send ${agentTurnText(hash, "a1")}`]);
      expect(lines).toEqual(["a1 started", "a1 done"]);
    });

    it("fails when the turn ends with no SubagentStop and sends nothing after it", async () => {
      const { deps, calls, lines } = turnHarness([[stopped], [stopped]]);

      const result = await runOn(deps, manifest(agent("a1"), prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(result.states).toEqual({ a1: "failed", p2: "waiting" });
      expect(calls).toEqual(["start", `send ${agentTurnText(hash, "a1")}`]);
      expect(lines).toEqual(["a1 started", `a1 failed: no SubagentStop for ${a1Type}`]);
    });

    it("is not done on a SubagentStop alone; the turn times out", async () => {
      const { deps, lines } = turnHarness([[subagentStopped(a1Type)]], 20);

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toMatch(/^a1 failed: .*no Stop for session s1 within 20 ms/);
    });

    it.each(["general-purpose", `${hash}:other`])(
      "fails when only a SubagentStop for %s arrives before Stop",
      async (otherType) => {
        const { deps, lines } = turnHarness([[subagentStopped(otherType), stopped]]);

        const result = await runOn(deps, manifest(agent("a1")));

        expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
        expect(lines.at(-1)).toBe(`a1 failed: no SubagentStop for ${a1Type}`);
      },
    );

    it("fails when its SubagentStop arrives only after Stop", async () => {
      const { deps, lines } = turnHarness([[stopped, subagentStopped(a1Type)]]);

      const result = await runOn(deps, manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toBe(`a1 failed: no SubagentStop for ${a1Type}`);
    });

    it("keeps recording its SubagentStop past a Stop stamped before its send", async () => {
      const { deps, lines } = turnHarness([]);
      const events = deps.events as FakeEventSource;
      deps.now = () => 2;
      deps.prompts = {
        sendPrompt: async () => {
          events.publish({ kind: "Stop", sessionId, payload: { flowdeck_hook_at: 1 } });
          events.publish({ kind: "SubagentStop", sessionId, payload: { agent_type: a1Type } });
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

    it("does not carry a SubagentStop seen in one agent's turn into the next", async () => {
      const { deps, lines } = turnHarness([
        [subagentStopped(a1Type), subagentStopped(`${hash}:a2`), stopped],
        [subagentStopped(a1Type), stopped],
      ]);

      const result = await runOn(deps, manifest(agent("a1"), agent("a2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a2" });
      expect(result.states).toEqual({ a1: "done", a2: "failed" });
      expect(lines).toEqual([
        "a1 started",
        "a1 done",
        "a2 started",
        `a2 failed: no SubagentStop for ${hash}:a2`,
      ]);
    });

    it("runs Prompt, Agent, Prompt in order, one turn each, starting Claude once", async () => {
      const { deps, calls, lines } = turnHarness([
        [stopped],
        [subagentStopped(a1Type), stopped],
        [stopped],
      ]);

      const result = await runOn(deps, manifest(prompt("p1"), agent("a1"), prompt("p2")));

      expect(result.outcome).toBe("done");
      expect(calls).toEqual([
        "start",
        `send /${hash}:p1`,
        `send ${agentTurnText(hash, "a1")}`,
        `send /${hash}:p2`,
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
      const { deps, calls } = turnHarness([[subagentStopped(a1Type), stopped]]);

      await runOn(deps, manifest(node("t", "trigger"), agent("a1"), node("o", "output")));

      expect(calls).toEqual(["start", `send ${agentTurnText(hash, "a1")}`]);
    });
  });

  describe("human nodes", () => {
    const gate = (id: string, skippable = false) =>
      node(id, "gate", { shown: "Check the plan", skippable });
    const hardstopSettings = {
      condition: "tests fail",
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

      const running = runOn(deps, manifest(prompt("p1"), gate("g1"), prompt("p2")));
      await vi.waitFor(() => expect(waiter.calls).toHaveLength(1));

      expect(sends(calls)).toEqual([`send /${hash}:p1`]);
      expect(waiter.calls).toEqual([{ nodeId: "g1", kind: "gate", shown: "Check the plan" }]);
      resolve(approve);
      const result = await running;

      expect(result.outcome).toBe("done");
      expect(sends(calls)).toEqual([`send /${hash}:p1`, `send /${hash}:p2`]);
      expect(lines).toEqual(["p1 started", "p1 done", "g1 approved", "p2 started", "p2 done"]);
      expect(result.decisions).toEqual([{ nodeId: "g1", decision: "approved" }]);
      expect(result.states).toEqual({ p1: "done", g1: "done", p2: "done" });
    });

    it("stops the run at a Gate rejected with a reason", async () => {
      const waiter = new FakeWaiter([{ decision: "reject", reason: "wrong scope" }]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(prompt("p1"), gate("g1"), prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "g1" });
      expect(result.states).toEqual({ p1: "done", g1: "failed", p2: "waiting" });
      expect(lines.at(-1)).toBe("g1 failed: rejected: wrong scope");
      expect(sends(calls)).toEqual([`send /${hash}:p1`]);
      expect(result.decisions).toEqual([
        { nodeId: "g1", decision: "rejected", reason: "wrong scope" },
      ]);
    });

    it("prints rejected alone for a reject with an empty reason", async () => {
      const waiter = new FakeWaiter([{ decision: "reject", reason: "" }]);
      const { deps, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(prompt("p1"), gate("g1"), prompt("p2")));

      expect(lines.at(-1)).toBe("g1 failed: rejected");
      expect(result.decisions).toEqual([{ nodeId: "g1", decision: "rejected", reason: "" }]);
    });

    it("skips a skippable Gate under auto without asking", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls, lines } = harness({ waiter, auto: true });

      const result = await runOn(deps, manifest(prompt("p1"), gate("g1", true), prompt("p2")));

      expect(result.outcome).toBe("done");
      expect(waiter.calls).toEqual([]);
      expect(lines).toEqual(["p1 started", "p1 done", "g1 skipped", "p2 started", "p2 done"]);
      expect(sends(calls)).toContain(`send /${hash}:p2`);
      expect(result.states["g1"]).toBe("skipped");
      expect(result.decisions).toEqual([{ nodeId: "g1", decision: "skipped" }]);
    });

    it("asks at a skippable Gate when auto is off", async () => {
      const waiter = new FakeWaiter([approve]);
      const { deps } = harness({ waiter });

      const result = await runOn(deps, manifest(prompt("p1"), gate("g1", true), prompt("p2")));

      expect(result.outcome).toBe("done");
      expect(waiter.calls).toHaveLength(1);
    });

    it("asks at a Gate that is not skippable even under auto", async () => {
      const waiter = new FakeWaiter([approve]);
      const { deps, lines } = harness({ waiter, auto: true });

      await runOn(deps, manifest(prompt("p1"), gate("g1"), prompt("p2")));

      expect(waiter.calls).toHaveLength(1);
      expect(lines).toContain("g1 approved");
    });

    it("asks at a Hard stop under auto and continues on continue", async () => {
      const waiter = new FakeWaiter([{ decision: "continue" }]);
      const { deps, lines } = harness({ waiter, auto: true });

      const result = await runOn(deps, manifest(prompt("p1"), hardstop("h1"), prompt("p2")));

      expect(waiter.calls).toEqual([
        { nodeId: "h1", kind: "hardstop", shown: "Check tests", condition: "tests fail" },
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

        await runOn(deps, manifest(prompt("p1"), hardstop("h1", settings), prompt("p2")));

        expect(waiter.calls).toHaveLength(1);
      },
    );

    it("stops the run at a Hard stop stopped with a reason", async () => {
      const waiter = new FakeWaiter([{ decision: "stop", reason: "tests fail" }]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(prompt("p1"), hardstop("h1"), prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "h1" });
      expect(lines.at(-1)).toBe("h1 failed: stopped: tests fail");
      expect(sends(calls)).toEqual([`send /${hash}:p1`]);
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

      const result = await runOn(deps, manifest(human, prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "x" });
      expect(lines).toEqual(["x failed: no answer: input closed"]);
      expect(result.decisions).toEqual([]);
    });

    it("fails a Gate with the waiter's error when the waiter throws", async () => {
      const { deps, lines } = harness({ waiter: new FakeWaiter([]) });

      const result = await runOn(deps, manifest(prompt("p1"), gate("g1"), prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "g1" });
      expect(lines.at(-1)).toBe("g1 failed: FakeWaiter: no scripted reply for g1");
    });

    it("attaches an Ask's answer to the next Prompt", async () => {
      const waiter = new FakeWaiter([answer("blue")]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await runOn(deps, manifest(ask("q1"), prompt("p1")));

      expect(lines).toEqual(["q1 answered: blue", "p1 started", "p1 done"]);
      expect(sends(calls)).toEqual([`send /${hash}:p1 The user answered: blue`]);
      expect(result.decisions).toEqual([{ nodeId: "q1", decision: "answered", answer: "blue" }]);
      expect(waiter.calls).toEqual([
        { nodeId: "q1", kind: "ask", question: "Pick a colour", options: ["red", "blue", "green"] },
      ]);
    });

    it("keeps an answer past a Script and a Gate for the next Prompt", async () => {
      const waiter = new FakeWaiter([answer("blue"), approve]);
      const { deps, calls } = harness({ waiter, results: [exit(0)] });

      await runOn(deps, manifest(ask("q1"), script("s1"), gate("g1"), prompt("p1")));

      expect(sends(calls)).toEqual([`send /${hash}:p1 The user answered: blue`]);
    });

    it("uses an answer once", async () => {
      const { deps, calls } = harness({ waiter: new FakeWaiter([answer("blue")]) });

      await runOn(deps, manifest(ask("q1"), prompt("p1"), prompt("p2")));

      expect(sends(calls)).toEqual([
        `send /${hash}:p1 The user answered: blue`,
        `send /${hash}:p2`,
      ]);
    });

    it("joins two answers in order on the next Prompt", async () => {
      const waiter = new FakeWaiter([answer("red"), answer("blue")]);
      const { deps, calls } = harness({ waiter });

      await runOn(deps, manifest(ask("q1"), ask("q2"), prompt("p1")));

      expect(sends(calls)).toEqual([
        `send /${hash}:p1 The user answered: red. The user answered: blue`,
      ]);
    });

    it("puts an answer before the next Agent's turn text", async () => {
      const waiter = new FakeWaiter([answer("blue")]);
      const { deps, calls, lines } = turnHarness(
        [[subagentStopped(`${hash}:a1`), stopped]],
        1000,
        waiter,
      );

      await runOn(deps, manifest(ask("q1"), agent("a1")));

      expect(sends(calls)).toEqual([`send The user answered: blue. ${agentTurnText(hash, "a1")}`]);
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
      manifest(loop("l1", settings), inLoop(prompt("r1")), inLoop(prompt("f1")), prompt("p9"));
    const replies = (...verdicts: boolean[]) =>
      verdicts.flatMap((done) => ["review", verdict(done)]);
    const answer = (text: string): WaitReply => ({ decision: "answer", answer: text });
    const sends = (calls: string[]) => calls.filter((call) => call.startsWith("send"));
    const rounds = (lines: string[]) => lines.filter((line) => /^l1 round \d+$/.test(line));
    const sendR1 = `send /${hash}:r1`;
    const sendF1 = `send /${hash}:f1 ${verdictRequest(condition)}`;
    const sendP9 = `send /${hash}:p9`;

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

      expect(sends(calls)).toEqual([
        `send /${hash}:r1`,
        `send /${hash}:f1 ${verdictRequest(condition)}`,
        `send /${hash}:p9`,
      ]);
      expect(sends(calls)[1]).toContain(`Condition: ${condition}`);
    });

    it("puts the verdict request after an Ask's answer on the verdict turn", async () => {
      const waiter = new FakeWaiter([answer("blue")]);
      const { deps, calls } = harness({ waiter, replies: [verdict(true)] });
      const ask = node("q1", "ask", { question: "Pick a colour", options: ["red", "blue"] });

      await runOn(deps, manifest(loop("l1"), inLoop(ask), inLoop(prompt("f1")), prompt("p9")));

      expect(sends(calls)[0]).toBe(
        `send /${hash}:f1 The user answered: blue ${verdictRequest(condition)}`,
      );
    });

    it("makes the last Prompt the verdict turn even with a Script after it", async () => {
      const { deps, calls, lines, scripts } = harness({
        results: [exit(0), exit(0)],
        replies: [verdict(false), verdict(true)],
      });

      const result = await runOn(
        deps,
        manifest(loop("l1"), inLoop(prompt("f1")), inLoop(script("s1")), prompt("p9")),
      );

      expect(result.outcome).toBe("done");
      expect(sends(calls)).toEqual([sendF1, sendF1, sendP9]);
      expect(scripts.calls).toHaveLength(2);
      expect(lines).toEqual([
        ...[1, 2].flatMap((round) => [
          `l1 round ${round}`,
          "f1 started",
          "f1 done",
          "s1 started",
          "s1 done",
        ]),
        "l1 done",
        "p9 started",
        "p9 done",
      ]);
    });

    it("asks an Agent verdict turn for the verdict and reads it from the main Stop", async () => {
      const { deps, calls, lines } = turnHarness([
        [
          { kind: "SubagentStop", agentType: `${hash}:a1`, reply: verdict(true) },
          { kind: "Stop", reply: verdict(false) },
        ],
      ]);

      await runOn(deps, manifest(loop("l1", { cap: 1 }), inLoop(agent("a1"))));

      expect(calls).toEqual(["start", `send ${agentVerdictTurnText(hash, "a1", condition)}`]);
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
        manifest(loop("l1"), inLoop(gate), inLoop(prompt("f1")), prompt("p9")),
      );

      expect(lines.filter((line) => line === "g1 skipped")).toHaveLength(2);
      expect(rounds(lines)).toHaveLength(2);
      expect(result.outcome).toBe("done");
    });

    it("fails the run at a failing body Script", async () => {
      const { deps, calls, lines } = harness({
        results: [exit(1)],
        replies: [verdict(false)],
      });

      const result = await runOn(
        deps,
        manifest(loop("l1"), inLoop(prompt("f1")), inLoop(script("s1")), prompt("p9")),
      );

      expect(result).toMatchObject({ outcome: "failed", failedNode: "s1" });
      expect(result.states).toMatchObject({ l1: "failed", s1: "failed", p9: "waiting" });
      expect(lines).not.toContain("l1 round 2");
      expect(lines.at(-1)).toBe("s1 failed: exit code 1");
      expect(sends(calls)).not.toContain(sendP9);
    });

    describe("structure check", () => {
      const refuses = async (nodes: ManifestNode[]) => {
        const { deps, calls, lines, scripts } = harness({ results: [exit(0)] });
        const error = await runOn(deps, manifest(...nodes)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(StructureError);
        expect(calls).toEqual([]);
        expect(scripts.calls).toEqual([]);
        expect(lines).toEqual([]);
        return error as StructureError;
      };

      it.each([
        ["no body", [loop("l1"), prompt("p9")]],
        ["a Script-only body", [loop("l1"), inLoop(script("s1")), prompt("p9")]],
      ])("refuses a loop with %s", async (_name, nodes) => {
        const error = await refuses(nodes);

        expect(error.message).toBe(
          "cannot run this build: l1 (loop) has no prompt or agent in its body",
        );
        expect(error.problems).toEqual(["l1 (loop) has no prompt or agent in its body"]);
      });

      it("refuses a loop inside a loop", async () => {
        const error = await refuses([
          loop("l1"),
          inLoop(prompt("p1")),
          inLoop(loop("l2")),
          inLoop(prompt("p2"), "l2"),
        ]);

        expect(error.problems).toContain("l2 (loop) is inside loop l1");
      });

      it("refuses a node whose parent is not a loop", async () => {
        const error = await refuses([script("s1"), inLoop(prompt("p1"), "s1")]);

        expect(error.problems).toEqual(["p1 (prompt) has parent s1, which is not a loop"]);
      });

      it("lists every problem in one error, in manifest order", async () => {
        const error = await refuses([loop("l1"), script("s1"), inLoop(prompt("p1"), "s1")]);

        expect(error.problems).toEqual([
          "l1 (loop) has no prompt or agent in its body",
          "p1 (prompt) has parent s1, which is not a loop",
        ]);
        expect(error.message).toBe(`cannot run this build: ${error.problems.join("; ")}`);
      });

      it("finds no problem in a loop with a Prompt in its body", () => {
        expect(structureProblems(reviewFix().nodes)).toEqual([]);
      });
    });
  });

  it("skips trigger and output nodes without a line or a call", async () => {
    const { deps, calls, lines } = harness();

    const result = await runOn(
      deps,
      manifest(node("t", "trigger"), prompt("p"), node("o", "output")),
    );

    expect(result.outcome).toBe("done");
    expect(calls).toEqual(["start", `send /${hash}:p`]);
    expect(lines).toEqual(["p started", "p done"]);
  });

  it("never starts Claude for a script-only manifest", async () => {
    const { deps, calls } = harness({ results: [exit(0), exit(0)] });

    const result = await runOn(deps, manifest(script("a"), script("b")));

    expect(result.outcome).toBe("done");
    expect(calls).toEqual([]);
  });

  it("starts Claude once, before the first prompt", async () => {
    const { deps, calls } = harness();

    await runOn(deps, manifest(prompt("a"), prompt("b"), prompt("c")));

    expect(calls.filter((call) => call === "start")).toHaveLength(1);
    expect(calls[0]).toBe("start");
  });

  it("writes one line per step, with script output indented under its node", async () => {
    const { deps, lines } = harness({ results: [exit(0, "out line\nsecond\n", "warn\n")] });

    await runOn(deps, manifest(prompt("p1"), script("s1")));

    expect(lines).toEqual([
      "p1 started",
      "p1 done",
      "s1 started",
      "  out line",
      "  second",
      "  warn",
      "s1 done",
    ]);
  });

  it("fails the prompt with the error when sending it rejects", async () => {
    const { deps, lines } = harness({ stop: "never" });
    const failing: TestDeps = {
      ...deps,
      turnTimeoutMs: 20,
      prompts: { sendPrompt: () => Promise.reject(new Error("box never emptied")) },
    };

    const result = await runOn(failing, manifest(prompt("a")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(lines).toEqual(["a started", "a failed: box never emptied"]);
  });

  it("fails the prompt with the error when Claude cannot start", async () => {
    const { deps, lines } = harness();
    const failing: TestDeps = {
      ...deps,
      session: { ensureStarted: () => Promise.reject(new Error("not ready within 30000 ms")) },
    };

    const result = await runOn(failing, manifest(prompt("a"), prompt("b")));

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

    await runOn(deps, manifest(prompt("a"), prompt("b"), prompt("c")));

    expect(deps.store.runs).toHaveLength(1);
    expect(deps.store.nodes).toHaveLength(3);
    for (const id of ["a", "b", "c"]) expect(nodeStatus(eventsOf(deps.store, id))).toBe("done");
  });

  it("marks a Prompt and an Agent sent before each send, and done only after the turn ends", async () => {
    const { deps } = turnHarness([[stopped], [subagentStopped(`${hash}:a1`), stopped]]);
    const store = new FakeStore();
    const seenAtSend: string[][] = [];
    const watched: TestDeps = {
      ...deps,
      store,
      prompts: {
        sendPrompt: async (text) => {
          seenAtSend.push(
            store.events(runIdOf(store)).map((event) => `${event.nodeId} ${event.kind}`),
          );
          await deps.prompts.sendPrompt(text);
        },
      },
    };

    await runOn(watched, manifest(prompt("p1"), agent("a1")));

    expect(seenAtSend).toEqual([["p1 sent"], ["p1 sent", "p1 done", "a1 sent"]]);
    expect(kindsOf(store, "a1")).toEqual(["sent", "done"]);
  });

  it("writes no done for a turn that never ends", async () => {
    const { deps } = harness({ stop: "never" });

    await runOn({ ...deps, turnTimeoutMs: 20 }, manifest(prompt("a")));

    expect(kindsOf(deps.store, "a")).toEqual(["sent", "failed"]);
  });

  it("stores a Prompt's Stop message on its done event", async () => {
    const { deps } = harness({ replies: ["X"] });

    await runOn(deps, manifest(prompt("p1")));

    expect(eventsOf(deps.store, "p1").at(-1)).toMatchObject({
      kind: "done",
      payload: { stopMessage: "X" },
    });
  });

  it("stores a Gate decision and an Ask answer as events and projects the decisions from them", async () => {
    const waiter = new FakeWaiter([approve, { decision: "answer", answer: "blue" }]);
    const { deps } = harness({ waiter });

    const result = await runOn(deps, manifest(gate("g1"), ask("q1"), prompt("p1")));

    expect(kindsOf(deps.store, "g1")).toEqual(["needs-you", "decided", "done"]);
    expect(kindsOf(deps.store, "q1")).toEqual(["needs-you", "answered", "done"]);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions).toEqual(decisionsOf(deps.store.events(runIdOf(deps.store))));
  });

  it("writes a round event per round and resets every body node before round 2", async () => {
    const { deps } = harness({ replies: ["review", verdict(false), "review", verdict(true)] });

    await runOn(deps, manifest(loop("l1"), inLoop(prompt("r1")), inLoop(prompt("f1"))));

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

      await runOn(deps, manifest(loop("l1"), inLoop(prompt("r1")), inLoop(prompt("f1"))));

      expect(batches()).toContainEqual(["l1 round", "r1 reset", "f1 reset"]);
    });

    it("writes the loop's running move after an 'again' answer in the same batch as the round", async () => {
      const waiter = new FakeWaiter([{ decision: "answer", answer: "again" }]);
      const { deps } = harness({ waiter, replies: ["no verdict here", verdict(true)] });
      const batches = batchesOf(deps.store);

      await runOn(deps, manifest(loop("l1"), inLoop(prompt("r1"))));

      expect(batches()).toContainEqual(["l1 running", "l1 round", "r1 reset"]);
    });

    it("writes an auto-skipped Gate's decision and its skip in one batch", async () => {
      const { deps } = harness({ auto: true });
      const batches = batchesOf(deps.store);

      await runOn(deps, manifest(node("g1", "gate", { shown: "Check", skippable: true })));

      expect(batches()).toContainEqual(["g1 decided", "g1 skipped"]);
    });

    it("writes a Script's retry and its next running move in one batch", async () => {
      const { deps } = harness({ results: [exit(2), exit(0)] });
      const batches = batchesOf(deps.store);

      await runOn(deps, manifest(script("s")));

      expect(batches()).toContainEqual(["s retry", "s running"]);
    });
  });

  it("writes running, retry, running for a retried Script", async () => {
    const { deps } = harness({ results: [exit(2), exit(0)] });

    await runOn(deps, manifest(script("s")));

    expect(kindsOf(deps.store, "s")).toEqual(["running", "retry", "running", "done"]);
  });

  describe("resuming a killed run", () => {
    function seeded(deps: TestDeps, m: RunnableManifest, entries: [string, RunEvent][]) {
      const { id } = deps.store.createRun(newRun(m));
      for (const [nodeId, event] of entries) deps.store.append(id, nodeId, event);
      return id;
    }
    const resume = (deps: TestDeps, m: RunnableManifest, runId: string, actions: ResumeActions) =>
      new Runner({ ...deps, runId }).run(m, { actions });
    const three = manifest(prompt("p1"), prompt("p2"), prompt("p3"));
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
      expect(sends(calls)).toEqual([`send /${hash}:p3`]);
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
      expect(sends(calls)).toEqual([`send /${hash}:p3`]);
      expect(kindsOf(deps.store, "p2")).toEqual(["sent", "done"]);
    });

    it.each([prompt("p2"), agent("p2")])(
      "accepts a waited $type node's Stop stamped before the wait",
      async (waited) => {
        const { deps, events } = harness();
        deps.now = () => 2;
        const m = manifest(prompt("p1"), waited);
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

      expect(sends(calls)).toEqual([`send /${hash}:p2`, `send /${hash}:p3`]);
      expect(kindsOf(deps.store, "p2")).toEqual(["sent", "done"]);
    });

    it("resends node 2 with the answer it was sent with", async () => {
      const { deps, calls } = harness();
      const m = manifest(ask("q1"), prompt("p1"));
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

      expect(sends(calls)).toEqual([`send /${hash}:p1 The user answered: blue`]);
    });

    it("keeps an answer given before the kill for the next Prompt", async () => {
      const { deps, calls } = harness();
      const m = manifest(ask("q1"), prompt("p1"));
      const runId = seeded(deps, m, [
        ["q1", { kind: "needs-you" }],
        [
          "q1",
          { kind: "answered", payload: { nodeId: "q1", decision: "answered", answer: "blue" } },
        ],
        ["q1", { kind: "done" }],
      ]);

      await resume(deps, m, runId, {});

      expect(sends(calls)).toEqual([`send /${hash}:p1 The user answered: blue`]);
    });

    it("fails a Script that was running when the runner stopped, without running it", async () => {
      const { deps, calls, scripts, lines } = harness({ results: [exit(0)] });
      const m = manifest(prompt("p1"), script("s2"), prompt("p3"));
      const runId = seeded(deps, m, [
        ["p1", { kind: "sent" }],
        ["p1", { kind: "done" }],
        ["s2", { kind: "running" }],
      ]);
      const message = "s2 failed: was running when the runner stopped";

      const result = await resume(deps, m, runId, { s2: { kind: "fail", message } });

      expect(result).toMatchObject({ outcome: "failed", failedNode: "s2" });
      expect(scripts.calls).toEqual([]);
      expect(sends(calls)).toEqual([]);
      expect(lines).toEqual([message]);
      expect(eventsOf(deps.store, "s2").at(-1)).toMatchObject({
        kind: "failed",
        payload: { message },
      });
    });

    describe("a Gate waiting on a human", () => {
      const m = manifest(prompt("p1"), gate("g1"), prompt("p2"));
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
        expect(sends(calls)).toEqual([`send /${hash}:p2`]);
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

    it("reuses an Ask answer recorded before the kill for the next Prompt", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls } = harness({ waiter });
      const m = manifest(ask("q1"), prompt("p1"));
      const decision = { nodeId: "q1", decision: "answered", answer: "blue" } as const;
      const runId = seeded(deps, m, [
        ["q1", { kind: "needs-you" }],
        ["q1", { kind: "answered", payload: decision }],
      ]);

      await resume(deps, m, runId, { q1: { kind: "reuse", decision } });

      expect(waiter.calls).toEqual([]);
      expect(sends(calls)).toEqual([`send /${hash}:p1 The user answered: blue`]);
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
      const m = manifest(loop("l1"), inLoop(prompt("r1")));
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
        inLoop(prompt("r1")),
      );
      const runId = seeded(deps, m, [...loopAsking(verdict(false)), loopAnswered("continue")]);

      const result = await resume(deps, m, runId, reuseAnswer("continue"));

      expect(waiter.calls).toEqual([]);
      expect(nodeStatus(eventsOf(deps.store, "l1"))).toBe("done");
      expect(result.outcome).toBe("done");
    });

    it("continues a Loop from round 2, and its next round is 3", async () => {
      const { deps, calls, lines } = harness({ replies: ["review", verdict(true)] });
      const m = manifest(loop("l1"), inLoop(prompt("r1")), inLoop(prompt("f1")), prompt("p9"));
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
      expect(sends(calls)).toEqual([
        `send /${hash}:r1`,
        `send /${hash}:f1 ${verdictRequest(condition)}`,
        `send /${hash}:p9`,
      ]);
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
  const blockedScripts = () => {
    let release: (result: ProcessResult) => void = () => undefined;
    const blocked = new Promise<ProcessResult>((resolve) => (release = resolve));
    let started = 0;
    return {
      scripts: { run: () => (started++, blocked) },
      started: () => started,
      release: () => release(exit(0)),
    };
  };

  async function askDuringTurn(waiter: FakeWaiter, options: { auto?: boolean } = {}) {
    const permissions = new FakePermissionSource();
    const h = harness({ waiter, permissions, stop: "never", ...options });
    const running = runOn(h.deps, manifest(prompt("n1")));
    await vi.waitFor(() => expect(sends(h.calls)).toHaveLength(1));
    const decision = await permissions.ask(sessionId, bash("echo hi"));
    h.events.publish({ kind: "Stop", sessionId, payload: {} });
    return { ...h, decision, result: await running };
  }

  it("asks the waiter for the prompt node in its turn and allows on approve", async () => {
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

  it("adds no event to the node for a permission wait", async () => {
    const { deps } = await askDuringTurn(new FakeWaiter([approve]));

    expect(kindsOf(deps.store, "n1")).toEqual(["sent", "done"]);
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
    events.publish({ kind: "SubagentStop", sessionId, payload: { agent_type: `${hash}:a1` } });
    events.publish({ kind: "Stop", sessionId, payload: {} });
    const result = await running;

    expect(waiter.calls).toEqual([{ ...permissionWait, nodeId: "a1" }]);
    expect(decision).toEqual({ behavior: "allow" });
    expect(result.outcome).toBe("done");
  });

  it.each([
    ["before the first send", [script("s1"), prompt("n1")]],
    ["after the turn ends", [prompt("n1"), script("s1")]],
  ])("denies without asking while no turn is open, %s", async (_when, nodes) => {
    const waiter = new FakeWaiter([]);
    const permissions = new FakePermissionSource();
    const blocked = blockedScripts();
    const { deps } = harness({ waiter, permissions });

    const running = runOn({ ...deps, scripts: blocked.scripts }, manifest(...nodes));
    await vi.waitFor(() => expect(blocked.started()).toBe(1));
    const decision = await permissions.ask(sessionId, bash("echo hi"));
    blocked.release();
    await running;

    expect(decision).toEqual({ behavior: "deny", message: "No node is running" });
    expect(waiter.calls).toEqual([]);
  });

  it("denies without asking once the run is over", async () => {
    const waiter = new FakeWaiter([]);
    const permissions = new FakePermissionSource();
    const { deps } = harness({ waiter, permissions });
    await runOn(deps, manifest(prompt("n1")));

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
    const running = runOn(deps, manifest(prompt("n1")));
    await vi.waitFor(() => expect(sends(calls)).toHaveLength(1));

    const one = permissions.ask(sessionId, bash("echo one"));
    const two = permissions.ask(sessionId, bash("echo two"));
    await vi.waitFor(() => expect(waiter.calls).toHaveLength(2));
    second.resolve({ decision: "reject", reason: "no" });
    expect(await two).toEqual({ behavior: "deny", message: "no" });
    first.resolve(approve);
    expect(await one).toEqual({ behavior: "allow" });
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
    const running = runOn({ ...deps, waiter, turnTimeoutMs: 50 }, manifest(prompt("n1")));
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
    const running = runOn({ ...deps, turnTimeoutMs: 50 }, manifest(prompt("n1")));
    await vi.waitFor(() => expect(sends(calls)).toHaveLength(1));

    const asked = permissions.ask(sessionId, bash("echo hi"));
    await new Promise((resolve) => setTimeout(resolve, 120));
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
  const twoPrompts = manifest(prompt("n1"), prompt("n2"));
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
      sendPrompt: async (text) => {
        await send(text);
        usage.setEntries(sessionId, spent(options.tokens ?? dollars120));
      },
    };
    return { ...h, usage };
  }

  it("asks with the spend before sending the next prompt once spend passes the budget", async () => {
    let resolve: (reply: WaitReply) => void = () => undefined;
    const waiter = new FakeWaiter([new Promise<WaitReply>((r) => (resolve = r))]);
    const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1 });

    const running = runOn(deps, twoPrompts);
    await vi.waitFor(() => expect(waiter.calls).toHaveLength(1));

    expect(waiter.calls).toEqual([budgetWait]);
    expect(sends(calls)).toEqual([`send /${hash}:n1`]);
    expect(kindsOf(deps.store, "n2")).not.toContain("sent");
    resolve(stop);
    await running;
  });

  it("sends the paused node once after a raise, without restarting the run", async () => {
    const waiter = new FakeWaiter([{ decision: "raise", budget: 2 }]);
    const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1 });

    const result = await runOn(deps, twoPrompts);

    expect(result.outcome).toBe("done");
    expect(sends(calls)).toEqual([`send /${hash}:n1`, `send /${hash}:n2`]);
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

    await runOn(deps, twoPrompts);

    expect(waiter.calls).toEqual([{ ...budgetWait, spend: 1 }]);
  });

  it("does not wait while the spend is below the budget", async () => {
    const waiter = new FakeWaiter([]);
    const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1, tokens: 49_500 });

    const result = await runOn(deps, twoPrompts);

    expect(waiter.calls).toEqual([]);
    expect(result.outcome).toBe("done");
    expect(sends(calls)).toHaveLength(2);
  });

  it("never reads usage without a budget", async () => {
    const waiter = new FakeWaiter([]);
    const { deps, usage } = spendAfterFirstSend({ waiter });

    const result = await runOn(deps, twoPrompts);

    expect(usage.calls).toEqual([]);
    expect(result.outcome).toBe("done");
  });

  it("never checks a script node", async () => {
    const waiter = new FakeWaiter([]);
    const usage = new FakeUsageSource();
    usage.setEntries(sessionId, spent(dollars120));
    const { deps } = harness({ waiter, usage, budget: 1, results: [exit(0)] });

    const result = await runOn(deps, manifest(script("s1")));

    expect(waiter.calls).toEqual([]);
    expect(result.outcome).toBe("done");
  });

  it("checks a loop body prompt before its send", async () => {
    const waiter = new FakeWaiter([stop]);
    const usage = new FakeUsageSource();
    usage.setEntries(sessionId, spent(dollars120));
    const { deps, calls } = harness({ waiter, usage, budget: 1 });
    const loop = node("l1", "loop", { condition: "no issues left", cap: 3, onCap: "fail" });

    const result = await runOn(deps, manifest(loop, { ...prompt("r1"), parent: "l1" }));

    expect(waiter.calls).toEqual([{ ...budgetWait, nodeId: "r1" }]);
    expect(sends(calls)).toEqual([]);
    expect(result.outcome).toBe("failed");
  });

  it("still waits under auto", async () => {
    const waiter = new FakeWaiter([stop]);
    const usage = new FakeUsageSource();
    usage.setEntries(sessionId, spent(dollars120));
    const { deps } = harness({ waiter, usage, budget: 1, auto: true });

    await runOn(deps, manifest(prompt("n1")));

    expect(waiter.calls).toEqual([{ ...budgetWait, nodeId: "n1" }]);
  });

  it.each<WaitReply>([stop, { decision: "closed" }])(
    "fails the run at the paused node on $decision, leaving it waiting",
    async (reply) => {
      const waiter = new FakeWaiter([reply]);
      const { deps, calls } = spendAfterFirstSend({ waiter, budget: 1 });

      const result = await runOn(deps, twoPrompts);

      expect(result).toMatchObject({ outcome: "failed", failedNode: "n2" });
      expect(result.states).toEqual({ n1: "done", n2: "waiting" });
      expect(sends(calls)).toEqual([`send /${hash}:n1`]);
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

      await runOn(deps, twoPrompts);

      expect(waiter.calls).toEqual([budgetWait]);
      expect(sends(calls)).toEqual([`send /${hash}:n1`]);
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

        const result = await runOn(deps, twoPrompts);

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

      await runOn(deps, twoPrompts);

      expect(waiter.calls).toEqual([budgetWait]);
    });

    it("does not take a matching message from before the send for the turn's", async () => {
      const earlier = message("m0", 0, "OK");
      const { deps, waiter } = landingLate({
        before: [earlier],
        stale: [earlier],
        landed: [earlier, message("m1", dollars120, "OK")],
      });

      await runOn(deps, twoPrompts);

      expect(waiter.calls).toEqual([budgetWait]);
    });

    it("waits for the Stop's message after resuming into a turn sent before", async () => {
      const waiter = new FakeWaiter([stop]);
      const usage = new FakeUsageSource();
      usage.setEntries(sessionId, [message("m1", dollars120, "OK")]);
      usage.queueReads(sessionId, []);
      const { deps, calls, events } = harness({ waiter, usage, budget: 1 });
      const { id } = deps.store.createRun(newRun(twoPrompts));
      deps.store.append(id, "n1", { kind: "sent" });

      const running = new Runner({ ...deps, runId: id }).run(twoPrompts, {
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

      await runOn(deps, twoPrompts);

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

      await runOn(deps, twoPrompts);

      expect(waiter.calls).toEqual([{ ...budgetWait, spend: 0, unconfirmed: true }]);
      expect(sends(calls)).toEqual([`send /${hash}:n1`]);
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
    const { id } = deps.store.createRun(newRun(twoPrompts));
    const paused = { kind: "budget", payload: { step: "paused", spend: 1.2, budget: 1 } };
    deps.store.append(id, "n1", { kind: "sent" });
    deps.store.append(id, "n1", { kind: "done" });
    deps.store.append(id, "n2", paused as RunEvent);

    const result = await new Runner({ ...deps, runId: id }).run(twoPrompts, { actions: {} });

    expect(waiter.calls).toEqual([budgetWait]);
    expect(sends(calls)).toEqual([]);
    expect(result).toMatchObject({ outcome: "failed", failedNode: "n2" });
  });
});
