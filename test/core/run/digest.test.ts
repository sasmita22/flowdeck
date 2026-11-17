import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import { usd } from "../../../src/core/run/budget.js";
import { costReport } from "../../../src/core/run/cost.js";
import { digestCap, runDigest, variablesText } from "../../../src/core/run/digest.js";
import { plainReason } from "../../../src/core/run/failure.js";
import type { StageSources } from "../../../src/core/run/manifest.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import type { BuildRecord, RunStatus, StoredEvent } from "../../../src/core/run/store.js";

const start = Date.parse("2026-11-15T10:00:00.000Z");
const at = (seconds: number) => start + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const build: BuildRecord = {
  id: "b1",
  hash: "abc1234",
  name: "nightly-login-fix",
  repo: "/work/shop-repo",
  base: "main",
  branch: "flowdeck/nightly-login-fix",
  branchCreated: true,
  values: { target: "login page", strict: true },
  deletedAt: null,
  dir: "/home/builds/b1",
  createdAt: at(-60),
  blueprintName: "Fix and verify",
  blueprintVersion: 3,
};

const then = (from: string, to: string) => ({
  kind: "then" as const,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const stages: StageSources = {
  session: { name: "login-session" },
  nodes: [
    { id: "start", type: "trigger", label: "Start" },
    { id: "fix", type: "agent", label: "Fix the login bug" },
    { id: "choose", type: "ask", label: "Pick the approach" },
    { id: "verify", type: "agent", label: "Run the test suite" },
    { id: "stop", type: "output", label: "Finish" },
  ],
  wires: [
    then("start", "fix"),
    then("fix", "choose"),
    then("choose", "verify"),
    then("verify", "stop"),
  ],
};

const failure = "verify failed: tests did not pass in CI";
const answer = "Take the smaller fix and keep the old session cookie for one more release";
const prUrl = "https://github.com/acme/shop/pull/42";

const stored = (entries: [string, number, RunEvent][]): StoredEvent[] =>
  entries.map(([nodeId, seconds, event], index) => ({
    ...event,
    nodeId,
    seq: index + 1,
    time: iso(seconds),
  }));

type Options = {
  retry?: boolean;
  reply?: string;
  extra?: [string, number, RunEvent][];
};

const eventsOf = ({
  retry = true,
  reply = "Patched the cookie check.",
  extra = [],
}: Options = {}) =>
  stored([
    ["start", 0, { kind: "running" }],
    ["start", 0, { kind: "done" }],
    ["fix", 1, { kind: "running" }],
    ...(retry
      ? ([
          ["fix", 3, { kind: "retry" }],
          ["fix", 4, { kind: "sent" }],
        ] as [string, number, RunEvent][])
      : []),
    ["fix", 5, { kind: "usage", payload: { messages: ["m1"] }, tokens: 1000, cost: 0.75 }],
    ...extra,
    ["fix", 20, { kind: "done", payload: { stopMessage: reply } }],
    ["choose", 21, { kind: "needs-you" }],
    [
      "choose",
      30,
      { kind: "answered", payload: { nodeId: "choose", decision: "answered", answer } },
    ],
    ["choose", 30, { kind: "done" }],
    ["verify", 31, { kind: "sent" }],
    ["verify", 40, { kind: "usage", payload: { messages: ["m2"] }, tokens: 500, cost: 0.5 }],
    ["verify", 125, { kind: "failed", payload: { message: failure } }],
  ]);

const written = (id: number, path: string): ActivityEntry => ({
  id,
  nodeId: "fix",
  at: at(6),
  kind: "tool",
  tool: "Write",
  path,
  summary: `write ${path}`,
});

const pr: ActivityEntry = {
  id: 9000,
  nodeId: "verify",
  at: at(100),
  kind: "pr",
  url: prUrl,
  summary: "opened a pull request",
};

type DigestInput = Parameters<typeof runDigest>[0];

const digestInput = (
  events: StoredEvent[],
  {
    activity = [written(1, "src/login.ts"), pr],
    sources = stages,
    status = "failed",
    endedAt = iso(125),
    questions = {},
  }: {
    activity?: ActivityEntry[];
    sources?: StageSources | null;
    status?: RunStatus;
    endedAt?: string | null;
    questions?: Record<string, string>;
  } = {},
): DigestInput => ({
  build,
  stages: sources,
  events,
  activity,
  cost: costReport({
    nodeIds: [...new Set(events.map((event) => event.nodeId))],
    events,
    pending: [],
    now: at(125),
  }),
  createdAt: iso(0),
  endedAt,
  status,
  questions,
});

describe("runDigest", () => {
  describe("facts", () => {
    const { text } = runDigest(digestInput(eventsOf()));

    it("names the failed stage and its plain reason", () => {
      expect(text).toContain("Run the test suite");
      expect(text).toContain(plainReason("verify", failure));
    });

    it("names the gate, its answer and the PR link", () => {
      expect(text).toContain("Pick the approach");
      expect(text).toContain(answer);
      expect(text).toContain(prUrl);
    });

    it("names the total cost and the run's start and end", () => {
      expect(text).toContain(usd(1.25));
      expect(text).toContain(iso(0));
      expect(text).toContain(iso(125));
    });

    it("says what the run was for: blueprint, session, variables and stage labels in order", () => {
      expect(text).toContain("Fix and verify");
      expect(text).toContain("login-session");
      expect(text).toContain("login page");
      const labels = ["Fix the login bug", "Pick the approach", "Run the test suite"];
      const positions = labels.map((label) => text.indexOf(label));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it("names each stage's status", () => {
      expect(text).toMatch(/done/);
      expect(text).toMatch(/failed/);
    });

    it("names a retry only when a stage retried", () => {
      expect(text).toMatch(/retr/i);
      expect(runDigest(digestInput(eventsOf({ retry: false }))).text).not.toMatch(/retr/i);
    });

    it("names the files written", () => {
      expect(text).toContain("src/login.ts");
    });

    it("includes the final reply of a finished stage", () => {
      expect(text).toContain("Patched the cookie check.");
    });
  });

  it("gives byte-identical output for the same inputs", () => {
    const first = runDigest(digestInput(eventsOf()));
    const second = runDigest(digestInput(eventsOf()));

    expect(second).toEqual(first);
    expect(second.text).toBe(first.text);
  });

  it("puts the build name, blueprint name and version, repo and variables in the header", () => {
    const { header } = runDigest(digestInput(eventsOf()));

    expect(header).toEqual({
      name: "nightly-login-fix",
      blueprintName: "Fix and verify",
      blueprintVersion: 3,
      repo: "/work/shop-repo",
      values: { target: "login page", strict: true },
    });
  });

  it("takes the stages from the events' node ids, in order, when there is no stored manifest", () => {
    const events = stored([
      ["node-alpha-17", 1, { kind: "sent" }],
      ["node-alpha-17", 5, { kind: "done" }],
      ["node-beta-42", 6, { kind: "sent" }],
      ["node-beta-42", 9, { kind: "failed", payload: { message: "node-beta-42 failed: no disk" } }],
    ]);

    const { text } = runDigest(digestInput(events, { sources: null, activity: [] }));

    expect(text).toContain("node-alpha-17");
    expect(text).toContain("node-beta-42");
    expect(text.indexOf("node-alpha-17")).toBeLessThan(text.indexOf("node-beta-42"));
    expect(text).toContain(plainReason("node-beta-42", "node-beta-42 failed: no disk"));
  });

  it("gives a run stopped before any stage started a short digest with its facts, status and time", () => {
    const result = runDigest(digestInput([], { status: "stopped", activity: [], endedAt: iso(3) }));

    expect(result.header.name).toBe("nightly-login-fix");
    expect(result.text).toContain("Fix and verify");
    expect(result.text).toMatch(/stopped/);
    expect(result.text).toContain(iso(0));
    expect(result.text).toContain(iso(3));
    expect(result.text.length).toBeLessThan(2000);
  });

  it("names budget pauses and compactions only when they happened", () => {
    const { text } = runDigest(
      digestInput(
        eventsOf({
          extra: [
            ["fix", 7, { kind: "budget", payload: { step: "paused", spend: 2, budget: 3 } }],
            ["fix", 8, { kind: "compacted", payload: { tokens: 50_000 } }],
          ],
        }),
      ),
    );
    const plain = runDigest(digestInput(eventsOf())).text;

    expect(text).toMatch(/budget/i);
    expect(text).toContain(usd(2));
    expect(text).toContain(usd(3));
    expect(text).toMatch(/compact/i);
    expect(plain).not.toMatch(/budget/i);
    expect(plain).not.toMatch(/compact/i);
  });

  describe("gate and ask stages", () => {
    const sources: StageSources = {
      session: { name: "review-session" },
      nodes: [
        { id: "g", type: "gate", label: "" },
        { id: "a", type: "ask", label: "Pick the approach" },
      ],
      wires: [then("g", "a")],
    };
    const events = stored([
      ["g", 1, { kind: "needs-you" }],
      ["g", 2, { kind: "decided", payload: { nodeId: "g", decision: "approved" } }],
      ["g", 2, { kind: "done" }],
      ["a", 3, { kind: "needs-you" }],
    ]);
    const digestOf = (questions: Record<string, string>) =>
      runDigest(digestInput(events, { sources, activity: [], status: "running", questions })).text;

    it("lists a stage with an empty label by its type's default label", () => {
      expect(digestOf({})).toContain("1. Gate (gate): done");
    });

    it("prints what a gate and an ask asked, under their stages", () => {
      const text = digestOf({ g: "Check the plan", a: "Which fix?" });

      expect(text).toContain("1. Gate (gate): done\n   Asked: Check the plan");
      expect(text).toContain("2. Pick the approach (ask): needs you\n   Asked: Which fix?");
    });

    it("reads a gate left waiting as stopped once the run is stopped", () => {
      const waiting = stored([["g", 1, { kind: "needs-you" }]]);
      const text = (status: RunStatus) =>
        runDigest(digestInput(waiting, { sources, activity: [], status })).text;

      expect(text("stopped")).toContain("1. Gate (gate): stopped");
      expect(text("stopped")).not.toContain("needs you");
      expect(text("running")).toContain("1. Gate (gate): needs you");
    });

    it("reads a stage left running as stopped once the run is stopped", () => {
      const running = stored([["g", 1, { kind: "running" }]]);
      const text = (status: RunStatus) =>
        runDigest(digestInput(running, { sources, activity: [], status })).text;

      expect(text("stopped")).toContain("1. Gate (gate): stopped");
      expect(text("running")).toContain("1. Gate (gate): running");
    });

    it("prints no Asked line for a stage with no question or an empty one", () => {
      expect(digestOf({ g: "" })).not.toContain("Asked:");
    });

    it("shortens a long question with the decision texts, keeping the digest under the cap", () => {
      const question = `Read this first. ${"every word of the checklist matters here. ".repeat(400)}`;

      const text = digestOf({ g: question, a: question });
      const asked = text.split("\n").filter((line) => line.startsWith("   Asked: "));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(asked).toHaveLength(2);
      for (const line of asked) {
        expect(line).toContain("Read this first.");
        expect(line.length).toBeLessThanOrEqual("   Asked: ".length + 501);
      }
    });
  });

  it("says plainly which facts were never recorded", () => {
    const bare: BuildRecord = {
      ...build,
      name: null,
      repo: null,
      values: null,
      blueprintName: null,
      blueprintVersion: null,
    };

    const { header, text } = runDigest({
      ...digestInput([], { sources: null, activity: [], status: "stopped", endedAt: null }),
      build: bare,
    });

    expect(header).toEqual({
      name: null,
      blueprintName: null,
      blueprintVersion: null,
      repo: null,
      values: null,
    });
    expect(text).toContain("Blueprint: unknown\n");
    expect(text).toContain(`Build: ${build.hash}\n`);
    expect(text).toContain("Repo: none\n");
    expect(text).toContain("Variables: none\n");
    expect(text).toContain("Ended: not recorded\n");
    expect(text).not.toContain("Session:");
  });

  it("names each kind of gate decision, with the reason a rejection gave", () => {
    const sources: StageSources = {
      session: { name: "review-session" },
      nodes: [
        { id: "g1", type: "gate", label: "Approve the plan" },
        { id: "g2", type: "gate", label: "Approve the release" },
      ],
      wires: [then("g1", "g2")],
    };
    const events = stored([
      ["g1", 1, { kind: "needs-you" }],
      ["g1", 1, { kind: "decided", payload: { nodeId: "g1", decision: "approved" } }],
      ["g1", 1, { kind: "done" }],
      ["g2", 2, { kind: "needs-you" }],
      [
        "g2",
        2,
        { kind: "decided", payload: { nodeId: "g2", decision: "rejected", reason: "not wanted" } },
      ],
      ["g2", 2, { kind: "failed", payload: { message: "g2 failed: rejected" } }],
    ]);

    const { text } = runDigest(digestInput(events, { sources, activity: [] }));

    expect(text).toContain("1. Approve the plan (gate): done\n   Decision: approved");
    expect(text).toContain("   Decision: rejected: not wanted");
  });

  it("lists the lanes of a fork and each round of a for each under their own numbers", () => {
    const sources: StageSources = {
      session: { name: "fan-session" },
      nodes: [
        { id: "split", type: "fork", label: "Split" },
        { id: "left", type: "agent", label: "Left lane work" },
        { id: "right", type: "agent", label: "Right lane work" },
        { id: "meet", type: "join", label: "Meet" },
        { id: "each", type: "foreach", label: "Each unit" },
        { id: "work", type: "agent", label: "Unit work", parent: "each" },
      ],
      wires: [
        then("split", "left"),
        then("split", "right"),
        then("left", "meet"),
        then("right", "meet"),
        then("meet", "each"),
      ],
    };
    const events = stored([
      ["each", 1, { kind: "round", payload: { round: 1, items: ["unit one", "unit two"] } }],
      ["work", 2, { kind: "sent" }],
      ["work", 3, { kind: "done" }],
      ["each", 4, { kind: "round", payload: { round: 2 } }],
      ["work", 4, { kind: "reset" }],
      ["work", 5, { kind: "sent" }],
    ]);

    const { text } = runDigest(digestInput(events, { sources, activity: [], status: "running" }));

    expect(text).toContain("2. In parallel:\n2.1.1. Left lane work (agent)");
    expect(text).toContain("2.2.1. Right lane work (agent)");
    expect(text).toContain("4. Round 1 (unit one):\n4.1.1. Unit work (agent): done");
    expect(text).toContain("4. Round 2 (unit two):\n4.2.1. Unit work (agent)");
  });

  describe("variablesText", () => {
    it("names each variable and its value, in order", () => {
      expect(variablesText({ target: "login page", strict: true })).toBe(
        "target = login page; strict = true",
      );
    });

    it("is empty for no variables", () => {
      expect(variablesText({})).toBe("");
      expect(variablesText(null)).toBe("");
    });
  });

  describe("cap", () => {
    const longReply = `Reply start. ${"the patch touched the cookie handler again. ".repeat(800)}`;
    const files = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        written(index + 1, `src/generated/file-${index + 1}.ts`),
      );

    it("is 12,000 characters", () => {
      expect(digestCap).toBe(12_000);
    });

    it("shortens a long final reply first, keeping every file when that is enough", () => {
      const activity = [...files(20), pr];

      const { text } = runDigest(digestInput(eventsOf({ reply: longReply }), { activity }));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).not.toContain(longReply);
      for (let index = 1; index <= 20; index += 1) {
        expect(text).toContain(`src/generated/file-${index}.ts`);
      }
    });

    it("cuts the files written before the decision texts, keeping the facts that always stay", () => {
      const activity = [...files(600), pr];

      const { text } = runDigest(digestInput(eventsOf({ reply: longReply }), { activity }));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain("src/generated/file-1.ts");
      expect(text).not.toContain("src/generated/file-600.ts");
      expect(text).toMatch(/and \d+ more/);
      expect(text).toContain(answer);
      expect(text).toContain("Run the test suite");
      expect(text).toContain(plainReason("verify", failure));
      expect(text).toContain(prUrl);
      expect(text).toContain(usd(1.25));
      expect(text).toContain(iso(0));
      expect(text).toContain(iso(125));
      expect(text).toMatch(/done/);
      expect(text).toMatch(/failed/);
    });

    it("shortens the decision texts only after every file written is cut", () => {
      const longAnswer = `Answer start. ${"keep the old cookie for one more release. ".repeat(350)}`;
      const events = eventsOf({ reply: longReply }).map((event) =>
        event.kind === "answered"
          ? ({ ...event, payload: { ...event.payload, answer: longAnswer } } as StoredEvent)
          : event,
      );

      const { text } = runDigest(digestInput(events, { activity: [...files(20), pr] }));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain("Answer start.");
      expect(text).not.toContain(longAnswer);
      expect(text).not.toContain("src/generated/file-1.ts");
      expect(text).toContain("…and 20 more");
      expect(text).toContain(plainReason("verify", failure));
      expect(text).toContain(prUrl);
    });

    it("never goes past the cap, even when the facts that always stay are longer than it", () => {
      const longFailure = `verify failed: ${"the suite crashed on a fixture. ".repeat(600)}`;
      const events = eventsOf({ retry: false }).map((event) =>
        event.kind === "failed"
          ? ({ ...event, payload: { message: longFailure } } as StoredEvent)
          : event,
      );

      const { text } = runDigest(digestInput(events));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text.startsWith("Blueprint: Fix and verify, version 3\n")).toBe(true);
    });
  });
});
