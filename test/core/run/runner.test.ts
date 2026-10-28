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
} from "../../../src/core/run/runner.js";
import type { ProcessResult } from "../../../src/ports/process-runner.js";
import type { WaitReply } from "../../../src/ports/waiter.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeProcessRunner } from "../../fakes/fake-process-runner.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";

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

type StopTiming = "during-send" | "after-send" | "never";

function harness(
  options: {
    results?: (ProcessResult | Error)[];
    stop?: StopTiming;
    waiter?: FakeWaiter;
    auto?: boolean;
    replies?: (string | undefined)[];
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
  const deps: RunnerDeps = {
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
  const deps: RunnerDeps = {
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

    const result = await new Runner(deps).run(manifest(prompt("a"), prompt("b"), prompt("c")));

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

    const result = await new Runner(deps).run(manifest(prompt("a")));

    expect(result.outcome).toBe("done");
    expect(result.states).toEqual({ a: "done" });
  });

  it("fails a prompt whose turn never ends and sends nothing after it", async () => {
    const { deps, calls, lines } = harness({ stop: "never" });

    const result = await new Runner({ ...deps, turnTimeoutMs: 20 }).run(
      manifest(prompt("a"), prompt("b")),
    );

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(result.states).toEqual({ a: "failed", b: "waiting" });
    expect(calls).toEqual(["start", `send /${hash}:a`]);
    expect(lines.at(-1)).toMatch(/^a failed: .*no Stop for session s1 within 20 ms/);
  });

  describe("script exit codes", () => {
    const run = async (results: (ProcessResult | Error)[]) => {
      const h = harness({ results });
      const result = await new Runner(h.deps).run(manifest(script("s"), prompt("next")));
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

      await new Runner(deps).run(
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

      const result = await new Runner(deps).run(manifest(agent("a1")));

      expect(result).toEqual({ outcome: "done", states: { a1: "done" }, decisions: [] });
      expect(calls).toEqual(["start", `send ${agentTurnText(hash, "a1")}`]);
      expect(lines).toEqual(["a1 started", "a1 done"]);
    });

    it("fails when the turn ends with no SubagentStop and sends nothing after it", async () => {
      const { deps, calls, lines } = turnHarness([[stopped], [stopped]]);

      const result = await new Runner(deps).run(manifest(agent("a1"), prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(result.states).toEqual({ a1: "failed", p2: "waiting" });
      expect(calls).toEqual(["start", `send ${agentTurnText(hash, "a1")}`]);
      expect(lines).toEqual(["a1 started", `a1 failed: no SubagentStop for ${a1Type}`]);
    });

    it("is not done on a SubagentStop alone; the turn times out", async () => {
      const { deps, lines } = turnHarness([[subagentStopped(a1Type)]], 20);

      const result = await new Runner(deps).run(manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toMatch(/^a1 failed: .*no Stop for session s1 within 20 ms/);
    });

    it.each(["general-purpose", `${hash}:other`])(
      "fails when only a SubagentStop for %s arrives before Stop",
      async (otherType) => {
        const { deps, lines } = turnHarness([[subagentStopped(otherType), stopped]]);

        const result = await new Runner(deps).run(manifest(agent("a1")));

        expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
        expect(lines.at(-1)).toBe(`a1 failed: no SubagentStop for ${a1Type}`);
      },
    );

    it("fails when its SubagentStop arrives only after Stop", async () => {
      const { deps, lines } = turnHarness([[stopped, subagentStopped(a1Type)]]);

      const result = await new Runner(deps).run(manifest(agent("a1")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "a1" });
      expect(lines.at(-1)).toBe(`a1 failed: no SubagentStop for ${a1Type}`);
    });

    it("does not carry a SubagentStop seen in one agent's turn into the next", async () => {
      const { deps, lines } = turnHarness([
        [subagentStopped(a1Type), subagentStopped(`${hash}:a2`), stopped],
        [subagentStopped(a1Type), stopped],
      ]);

      const result = await new Runner(deps).run(manifest(agent("a1"), agent("a2")));

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

      const result = await new Runner(deps).run(manifest(prompt("p1"), agent("a1"), prompt("p2")));

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

      await new Runner(deps).run(manifest(node("t", "trigger"), agent("a1"), node("o", "output")));

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

      const running = new Runner(deps).run(manifest(prompt("p1"), gate("g1"), prompt("p2")));
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

      const result = await new Runner(deps).run(manifest(prompt("p1"), gate("g1"), prompt("p2")));

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

      const result = await new Runner(deps).run(manifest(prompt("p1"), gate("g1"), prompt("p2")));

      expect(lines.at(-1)).toBe("g1 failed: rejected");
      expect(result.decisions).toEqual([{ nodeId: "g1", decision: "rejected", reason: "" }]);
    });

    it("skips a skippable Gate under auto without asking", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls, lines } = harness({ waiter, auto: true });

      const result = await new Runner(deps).run(
        manifest(prompt("p1"), gate("g1", true), prompt("p2")),
      );

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

      const result = await new Runner(deps).run(
        manifest(prompt("p1"), gate("g1", true), prompt("p2")),
      );

      expect(result.outcome).toBe("done");
      expect(waiter.calls).toHaveLength(1);
    });

    it("asks at a Gate that is not skippable even under auto", async () => {
      const waiter = new FakeWaiter([approve]);
      const { deps, lines } = harness({ waiter, auto: true });

      await new Runner(deps).run(manifest(prompt("p1"), gate("g1"), prompt("p2")));

      expect(waiter.calls).toHaveLength(1);
      expect(lines).toContain("g1 approved");
    });

    it("asks at a Hard stop under auto and continues on continue", async () => {
      const waiter = new FakeWaiter([{ decision: "continue" }]);
      const { deps, lines } = harness({ waiter, auto: true });

      const result = await new Runner(deps).run(
        manifest(prompt("p1"), hardstop("h1"), prompt("p2")),
      );

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

        await new Runner(deps).run(manifest(prompt("p1"), hardstop("h1", settings), prompt("p2")));

        expect(waiter.calls).toHaveLength(1);
      },
    );

    it("stops the run at a Hard stop stopped with a reason", async () => {
      const waiter = new FakeWaiter([{ decision: "stop", reason: "tests fail" }]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await new Runner(deps).run(
        manifest(prompt("p1"), hardstop("h1"), prompt("p2")),
      );

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

      const result = await new Runner(deps).run(manifest(human, prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "x" });
      expect(lines).toEqual(["x failed: no answer: input closed"]);
      expect(result.decisions).toEqual([]);
    });

    it("fails a Gate with the waiter's error when the waiter throws", async () => {
      const { deps, lines } = harness({ waiter: new FakeWaiter([]) });

      const result = await new Runner(deps).run(manifest(prompt("p1"), gate("g1"), prompt("p2")));

      expect(result).toMatchObject({ outcome: "failed", failedNode: "g1" });
      expect(lines.at(-1)).toBe("g1 failed: FakeWaiter: no scripted reply for g1");
    });

    it("attaches an Ask's answer to the next Prompt", async () => {
      const waiter = new FakeWaiter([answer("blue")]);
      const { deps, calls, lines } = harness({ waiter });

      const result = await new Runner(deps).run(manifest(ask("q1"), prompt("p1")));

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

      await new Runner(deps).run(manifest(ask("q1"), script("s1"), gate("g1"), prompt("p1")));

      expect(sends(calls)).toEqual([`send /${hash}:p1 The user answered: blue`]);
    });

    it("uses an answer once", async () => {
      const { deps, calls } = harness({ waiter: new FakeWaiter([answer("blue")]) });

      await new Runner(deps).run(manifest(ask("q1"), prompt("p1"), prompt("p2")));

      expect(sends(calls)).toEqual([
        `send /${hash}:p1 The user answered: blue`,
        `send /${hash}:p2`,
      ]);
    });

    it("joins two answers in order on the next Prompt", async () => {
      const waiter = new FakeWaiter([answer("red"), answer("blue")]);
      const { deps, calls } = harness({ waiter });

      await new Runner(deps).run(manifest(ask("q1"), ask("q2"), prompt("p1")));

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

      await new Runner(deps).run(manifest(ask("q1"), agent("a1")));

      expect(sends(calls)).toEqual([`send The user answered: blue. ${agentTurnText(hash, "a1")}`]);
      expect(lines).toContain("a1 done");
    });

    it("sends nothing and starts nothing for an Ask with nothing after it", async () => {
      const { deps, calls, lines } = harness({ waiter: new FakeWaiter([answer("blue")]) });

      const result = await new Runner(deps).run(manifest(ask("q1")));

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

      const result = await new Runner(deps).run(reviewFix());

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

      const result = await new Runner(deps).run(reviewFix({ onCap: "ask" }));

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

      const result = await new Runner(deps).run(reviewFix({ onCap: "ask" }));

      expect(lines.at(-1)).toBe("l1 failed: cap reached after 3 rounds");
      expect(sends(calls)).not.toContain(sendP9);
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
    });

    it("asks at the cap on cap ask even under auto", async () => {
      const waiter = new FakeWaiter([answer("continue")]);
      const { deps } = harness({ waiter, auto: true, replies: replies(false, false, false) });

      await new Runner(deps).run(reviewFix({ onCap: "ask" }));

      expect(waiter.calls).toHaveLength(1);
    });

    it("runs exactly two rounds when the verdict is done in round 2", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, calls, lines } = harness({ waiter, replies: replies(false, true) });

      const result = await new Runner(deps).run(reviewFix());

      expect(sends(calls)).toEqual([sendR1, sendF1, sendR1, sendF1, sendP9]);
      expect(rounds(lines)).toEqual(["l1 round 1", "l1 round 2"]);
      expect(lines.slice(-3)).toEqual(["l1 done", "p9 started", "p9 done"]);
      expect(waiter.calls).toEqual([]);
      expect(result.outcome).toBe("done");
    });

    it("leaves the loop and its body done after the last round", async () => {
      const { deps } = harness({ replies: replies(false, true) });

      const result = await new Runner(deps).run(reviewFix());

      expect(result.states).toMatchObject({ l1: "done", r1: "done", f1: "done", p9: "done" });
    });

    it("exits normally when the verdict is done on the last round", async () => {
      const waiter = new FakeWaiter([]);
      const { deps, lines } = harness({ waiter, replies: replies(false, false, true) });

      const result = await new Runner(deps).run(reviewFix({ onCap: "ask" }));

      expect(rounds(lines)).toHaveLength(3);
      expect(waiter.calls).toEqual([]);
      expect(lines).toContain("l1 done");
      expect(result.outcome).toBe("done");
    });

    it("runs one round when the verdict is done in round 1", async () => {
      const { deps, calls, lines } = harness({ replies: replies(true) });

      await new Runner(deps).run(reviewFix());

      expect(rounds(lines)).toEqual(["l1 round 1"]);
      expect(sends(calls)).toEqual([sendR1, sendF1, sendP9]);
    });

    it("pauses on a reply with no verdict until the answer, running nothing more", async () => {
      let resolve: (reply: WaitReply) => void = () => undefined;
      const waiter = new FakeWaiter([new Promise<WaitReply>((r) => (resolve = r))]);
      const { deps, calls, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      const running = new Runner(deps).run(reviewFix());
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

      await new Runner(deps).run(reviewFix());

      expect(waiter.calls).toEqual([malformedRequest("l1", 1, "no reply")]);
    });

    it("runs another round on again", async () => {
      const waiter = new FakeWaiter([answer("again")]);
      const { deps, calls, lines } = harness({
        waiter,
        replies: ["review", "no verdict here", "review", verdict(true)],
      });

      const result = await new Runner(deps).run(reviewFix());

      expect(rounds(lines)).toEqual(["l1 round 1", "l1 round 2"]);
      expect(sends(calls)).toEqual([sendR1, sendF1, sendR1, sendF1, sendP9]);
      expect(lines).toContain("l1 done");
      expect(result.outcome).toBe("done");
    });

    it("counts again toward the cap", async () => {
      const waiter = new FakeWaiter([answer("again")]);
      const { deps, calls, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      await new Runner(deps).run(reviewFix({ cap: 1 }));

      expect(rounds(lines)).toEqual(["l1 round 1"]);
      expect(sends(calls)).toEqual([sendR1, sendF1]);
      expect(lines.at(-1)).toBe("l1 failed: cap reached after 1 rounds");
    });

    it("fails the loop on fail after a reply with no verdict", async () => {
      const waiter = new FakeWaiter([answer("fail")]);
      const { deps, calls, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      const result = await new Runner(deps).run(reviewFix());

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

      await new Runner(deps).run(reviewFix());

      expect(waiter.calls).toHaveLength(1);
      expect(lines).toContain("l1 done");
    });

    it("fails the loop when the input closes while it asks", async () => {
      const waiter = new FakeWaiter([{ decision: "closed" }]);
      const { deps, lines } = harness({ waiter, replies: ["review", "no verdict here"] });

      const result = await new Runner(deps).run(reviewFix());

      expect(lines.at(-1)).toBe("l1 failed: no answer: input closed");
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
    });

    it("fails the loop with the waiter's error when the waiter throws", async () => {
      const { deps, calls, lines } = harness({
        waiter: new FakeWaiter([]),
        replies: ["review", "no verdict here"],
      });

      const result = await new Runner(deps).run(reviewFix());

      expect(lines.at(-1)).toBe("l1 failed: FakeWaiter: no scripted reply for l1");
      expect(result).toMatchObject({ outcome: "failed", failedNode: "l1" });
      expect(result.states["l1"]).toBe("failed");
      expect(sends(calls)).not.toContain(sendP9);
    });

    it("sends the verdict request on the verdict turn only", async () => {
      const { deps, calls } = harness({ replies: replies(true) });

      await new Runner(deps).run(reviewFix());

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

      await new Runner(deps).run(
        manifest(loop("l1"), inLoop(ask), inLoop(prompt("f1")), prompt("p9")),
      );

      expect(sends(calls)[0]).toBe(
        `send /${hash}:f1 The user answered: blue ${verdictRequest(condition)}`,
      );
    });

    it("makes the last Prompt the verdict turn even with a Script after it", async () => {
      const { deps, calls, lines, scripts } = harness({
        results: [exit(0), exit(0)],
        replies: [verdict(false), verdict(true)],
      });

      const result = await new Runner(deps).run(
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

      await new Runner(deps).run(manifest(loop("l1", { cap: 1 }), inLoop(agent("a1"))));

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

      const result = await new Runner(deps).run(
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

      const result = await new Runner(deps).run(
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
        const error = await new Runner(deps).run(manifest(...nodes)).catch((e: unknown) => e);
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

    const result = await new Runner(deps).run(
      manifest(node("t", "trigger"), prompt("p"), node("o", "output")),
    );

    expect(result.outcome).toBe("done");
    expect(calls).toEqual(["start", `send /${hash}:p`]);
    expect(lines).toEqual(["p started", "p done"]);
  });

  it("never starts Claude for a script-only manifest", async () => {
    const { deps, calls } = harness({ results: [exit(0), exit(0)] });

    const result = await new Runner(deps).run(manifest(script("a"), script("b")));

    expect(result.outcome).toBe("done");
    expect(calls).toEqual([]);
  });

  it("starts Claude once, before the first prompt", async () => {
    const { deps, calls } = harness();

    await new Runner(deps).run(manifest(prompt("a"), prompt("b"), prompt("c")));

    expect(calls.filter((call) => call === "start")).toHaveLength(1);
    expect(calls[0]).toBe("start");
  });

  it("writes one line per step, with script output indented under its node", async () => {
    const { deps, lines } = harness({ results: [exit(0, "out line\nsecond\n", "warn\n")] });

    await new Runner(deps).run(manifest(prompt("p1"), script("s1")));

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
    const failing: RunnerDeps = {
      ...deps,
      turnTimeoutMs: 20,
      prompts: { sendPrompt: () => Promise.reject(new Error("box never emptied")) },
    };

    const result = await new Runner(failing).run(manifest(prompt("a")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(lines).toEqual(["a started", "a failed: box never emptied"]);
  });

  it("fails the prompt with the error when Claude cannot start", async () => {
    const { deps, lines } = harness();
    const failing: RunnerDeps = {
      ...deps,
      session: { ensureStarted: () => Promise.reject(new Error("not ready within 30000 ms")) },
    };

    const result = await new Runner(failing).run(manifest(prompt("a"), prompt("b")));

    expect(result).toMatchObject({ outcome: "failed", failedNode: "a" });
    expect(result.states).toEqual({ a: "failed", b: "waiting" });
    expect(lines).toEqual(["a started", "a failed: not ready within 30000 ms"]);
  });
});
