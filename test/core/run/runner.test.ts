import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import { agentTurnText } from "../../../src/core/nodes/agent/execute.js";
import {
  Runner,
  UnsupportedNodesError,
  unsupportedNodes,
  type RunnerDeps,
  type RunnableManifest,
} from "../../../src/core/run/runner.js";
import type { ProcessResult } from "../../../src/ports/process-runner.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeProcessRunner } from "../../fakes/fake-process-runner.js";

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

function harness(options: { results?: (ProcessResult | Error)[]; stop?: StopTiming } = {}) {
  const events = new FakeEventSource();
  const scripts = new FakeProcessRunner(options.results ?? []);
  const calls: string[] = [];
  const lines: string[] = [];
  const stop = options.stop ?? "after-send";
  const publishStop = () => events.publish({ kind: "Stop", sessionId, payload: {} });
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
    onChange: (line) => lines.push(line),
    cwd,
    sessionId,
    turnTimeoutMs: 1000,
  };
  return { deps, events, scripts, calls, lines };
}

type Emitted = { kind: "Stop" } | { kind: "SubagentStop"; agentType: string };

const stopped: Emitted = { kind: "Stop" };
const subagentStopped = (agentType: string): Emitted => ({ kind: "SubagentStop", agentType });
const agent = (id: string) => node(id, "agent", { instructions: "Write notes.md." });

function turnHarness(turns: Emitted[][], turnTimeoutMs = 1000) {
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
            payload: event.kind === "SubagentStop" ? { agent_type: event.agentType } : {},
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

      expect(result).toEqual({ outcome: "done", states: { a1: "done" } });
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

  it.each(["gate", "ask", "hardstop", "loop"] as const)(
    "refuses a manifest with a %s node before doing anything",
    async (type) => {
      const { deps, calls, lines, scripts } = harness({ results: [exit(0)] });

      await expect(
        new Runner(deps).run(manifest(script("s"), prompt("p"), node("x", type))),
      ).rejects.toThrow(UnsupportedNodesError);
      expect(calls).toEqual([]);
      expect(scripts.calls).toEqual([]);
      expect(lines).toEqual([]);
    },
  );

  it("lists every unsupported node in one error", async () => {
    const nodes = [node("a1", "agent"), prompt("p"), node("g1", "gate"), node("l1", "loop")];
    const { deps } = harness();

    expect(unsupportedNodes(nodes).map((n) => n.id)).toEqual(["g1", "l1"]);
    await expect(new Runner(deps).run(manifest(...nodes))).rejects.toThrow(
      /: g1 \(gate\), l1 \(loop\)$/,
    );
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
