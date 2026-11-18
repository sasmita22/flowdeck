import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import { usd } from "../../../src/core/run/budget.js";
import { costReport } from "../../../src/core/run/cost.js";
import { digestCap, runDigest, variablesText } from "../../../src/core/run/digest.js";
import { plainReason } from "../../../src/core/run/failure.js";
import type { StageSources } from "../../../src/core/run/manifest.js";
import {
  otherReposText,
  repoStateText,
  type RepoState,
  type RunRepoStates,
} from "../../../src/core/run/repo-state.js";
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

const step = (
  id: number,
  nodeId: string,
  seconds: number,
  tool: string,
  summary: string,
  result?: "ok" | "error",
): ActivityEntry => ({
  id,
  nodeId,
  at: at(seconds),
  kind: "tool",
  tool,
  summary,
  ...(result === undefined ? {} : { result }),
});

const subagent = (id: number, nodeId: string, seconds: number, report: string): ActivityEntry => ({
  id,
  nodeId,
  at: at(seconds),
  kind: "subagent",
  agentType: "general-purpose",
  state: "finished",
  agentId: `agent-${id}`,
  summary: "general-purpose",
  report,
});

const withInstructions = (instructions: Record<string, string>) => ({
  ...stages,
  nodes: stages.nodes.map((node) =>
    instructions[node.id] === undefined ? node : { ...node, instructions: instructions[node.id] },
  ),
});

const stageBlock = (text: string, heading: string): string[] => {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.startsWith(heading));
  if (from < 0) throw new Error(`no stage "${heading}" in the digest`);
  const to = lines.findIndex((line, index) => index > from && /^\d+(\.\d+)*\. /.test(line));
  return lines.slice(from + 1, to < 0 ? undefined : to).map((line) => line.trim());
};

const stepLines = (block: string[]): string[] => {
  const from = block.indexOf("Steps:");
  if (from < 0) return [];
  const rest = block.slice(from + 1);
  const end = rest.findIndex((line) => !line.startsWith("- "));
  return end < 0 ? rest : rest.slice(0, end);
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
    repoStates,
  }: {
    activity?: ActivityEntry[];
    sources?: StageSources | null;
    status?: RunStatus;
    endedAt?: string | null;
    questions?: Record<string, string>;
    repoStates?: RunRepoStates;
  } = {},
): DigestInput => ({
  ...(repoStates === undefined ? {} : { repoStates }),
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
      branch: "flowdeck/nightly-login-fix",
      values: { target: "login page", strict: true },
    });
  });

  it("names the branch on the line after the repo", () => {
    const { text } = runDigest(digestInput(eventsOf()));

    expect(text).toContain("Repo: /work/shop-repo\nBranch: flowdeck/nightly-login-fix\n");
  });

  describe("repo states", () => {
    const before: RepoState = {
      kind: "read",
      branch: "flowdeck/nightly-login-fix",
      head: "1a2b3c4d5e6f7a8b",
      upstream: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
    };
    const after: RepoState = {
      kind: "read",
      branch: "flowdeck/nightly-login-fix",
      head: "9f8e7d6c5b4a",
      upstream: { name: "origin/main", ahead: 2, behind: 1 },
      staged: 1,
      unstaged: 2,
      untracked: 3,
    };
    const states: RunRepoStates = { before, after, otherRepos: [] };
    const others = [
      { path: "/x/ios", branch: "develop" },
      { path: "/u/web", branch: "master" },
    ];

    it("puts the before and after states straight after the branch", () => {
      const { text } = runDigest(digestInput(eventsOf(), { repoStates: states }));

      expect(text).toContain(
        `Branch: flowdeck/nightly-login-fix\nBefore: ${repoStateText(states.before)}\nAfter: ${repoStateText(states.after)}\nVariables: `,
      );
    });

    it("reads not recorded for both states when the run has none", () => {
      const { text } = runDigest(digestInput(eventsOf()));

      expect(text).toContain(
        "Branch: flowdeck/nightly-login-fix\nBefore: not recorded\nAfter: not recorded\nVariables: ",
      );
    });

    it("names the other repos after the after state and in the header", () => {
      const { header, text } = runDigest(
        digestInput(eventsOf(), { repoStates: { ...states, otherRepos: others } }),
      );

      expect(text).toContain(
        `After: ${repoStateText(states.after)}\nOther repos: ${otherReposText(others)}\nVariables: `,
      );
      expect(header.otherRepos).toEqual(others);
    });

    it("gives each other repo's before and after on the other repos line", () => {
      const tracked = [{ path: "/x/ios", branch: "develop", before, after }];
      const { text } = runDigest(
        digestInput(eventsOf(), { repoStates: { ...states, otherRepos: tracked } }),
      );

      expect(text).toContain(
        `\nOther repos: /x/ios (develop): before ${repoStateText(before)}; after ${repoStateText(after)}\nVariables: `,
      );
    });

    it("keeps today's header and adds no other repos line when there are none", () => {
      const { header, text } = runDigest(digestInput(eventsOf(), { repoStates: states }));

      expect(header).toEqual({
        name: "nightly-login-fix",
        blueprintName: "Fix and verify",
        blueprintVersion: 3,
        repo: "/work/shop-repo",
        branch: "flowdeck/nightly-login-fix",
        values: { target: "login page", strict: true },
      });
      expect("otherRepos" in header).toBe(false);
      expect(text).not.toContain("Other repos:");
    });

    it("gives byte-identical output for the same repo states", () => {
      const repoStates = { ...states, otherRepos: others };
      const first = runDigest(digestInput(eventsOf(), { repoStates }));
      const second = runDigest(
        digestInput(eventsOf(), { repoStates: structuredClone(repoStates) }),
      );

      expect(second).toEqual(first);
      expect(second.text).toBe(first.text);
    });
  });

  describe("what each Agent stage was asked, reported and did", () => {
    const instructed = withInstructions({ fix: "Fix the cookie check in src/login.ts." });
    const activity = [
      step(1, "fix", 6, "Bash", "npm test", "ok"),
      step(2, "fix", 7, "Read", "src/login.ts", "error"),
      step(3, "fix", 8, "Grep", "cookie"),
      subagent(4, "fix", 9, "Patched src/login.ts; the cookie check passes."),
      step(5, "verify", 50, "Bash", "npm run e2e", "error"),
    ];
    const text = runDigest(digestInput(eventsOf(), { sources: instructed, activity })).text;
    const fix = stageBlock(text, "2. Fix the login bug (agent)");
    const verify = stageBlock(text, "4. Run the test suite (agent)");
    const choose = stageBlock(text, "3. Pick the approach (ask)");

    it("gives an Agent stage its instructions, or says they were not recorded", () => {
      expect(fix).toContain("Instructions: Fix the cookie check in src/login.ts.");
      expect(verify).toContain("Instructions: not recorded");
    });

    it("gives an Agent stage its subagent's report, or says it was not recorded", () => {
      expect(fix).toContain("Report: Patched src/login.ts; the cookie check passes.");
      expect(verify).toContain("Report: not recorded");
    });

    it("gives a stage that is not an Agent no instructions or report line", () => {
      expect(choose.some((line) => line.startsWith("Instructions:"))).toBe(false);
      expect(choose.some((line) => line.startsWith("Report:"))).toBe(false);
    });

    it("lists each tool step of a stage in order with its result, or not recorded when it has none after the run ended", () => {
      expect(stepLines(fix)).toEqual([
        "- Bash npm test → ok",
        "- Read src/login.ts → error",
        "- Grep cookie → not recorded",
      ]);
      expect(stepLines(verify)).toEqual(["- Bash npm run e2e → error"]);
    });

    it.each<RunStatus>(["running", "stopped"])(
      "says a step with no result is running in a %s run",
      (status) => {
        const digest = runDigest(
          digestInput(eventsOf(), { sources: instructed, activity, status }),
        ).text;

        expect(stepLines(stageBlock(digest, "2. Fix the login bug (agent)"))).toContain(
          "- Grep cookie → running",
        );
      },
    );
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
      branch: null,
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
      branch: null,
      values: null,
    });
    expect(text).toContain("Blueprint: unknown\n");
    expect(text).toContain(`Build: ${build.hash}\n`);
    expect(text).toContain("Repo: none\n");
    expect(text).toContain("Branch: none\n");
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

    it("stays under the cap with the longest before, after and other repos lines", () => {
      const longFailure = `verify failed: ${"the suite crashed on a fixture. ".repeat(600)}`;
      const events = eventsOf({ retry: false }).map((event) =>
        event.kind === "failed"
          ? ({ ...event, payload: { message: longFailure } } as StoredEvent)
          : event,
      );
      const long = "x".repeat(500);
      const state = {
        kind: "read" as const,
        branch: long,
        head: long,
        upstream: { name: long, ahead: 999_999, behind: 999_999 },
        staged: 999_999,
        unstaged: 999_999,
        untracked: 999_999,
      };
      const otherRepos = Array.from({ length: 50 }, (_, index) => ({
        path: `/${long}/${index}`,
        branch: long,
      }));

      const { text } = runDigest(
        digestInput(events, { repoStates: { before: state, after: state, otherRepos } }),
      );

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain(`Before: ${repoStateText(state)}\n`);
      expect(text).toContain(`Other repos: ${otherReposText(otherRepos)}\n`);
    });

    it("stays under the cap with twelve other repos at their longest before and after", () => {
      const long = "x".repeat(500);
      const state = {
        kind: "read" as const,
        branch: long,
        head: long,
        upstream: { name: long, ahead: 999_999, behind: 999_999 },
        staged: 999_999,
        unstaged: 999_999,
        untracked: 999_999,
      };
      const otherRepos = Array.from({ length: 12 }, (_, index) => ({
        path: `/${long}/${index}`,
        branch: long,
        before: state,
        after: state,
      }));

      const { text } = runDigest(
        digestInput(eventsOf(), { repoStates: { before: state, after: state, otherRepos } }),
      );

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain(`Other repos: ${otherReposText(otherRepos)}\n`);
      expect(otherReposText(otherRepos)).toContain(`: before ${repoStateText(state)}; after `);
    });

    const report = (length: number) =>
      `Report start. ${"the cookie check now reads the new header. ".repeat(length / 43)}`;
    const checks = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        step(index + 1, "fix", 6, "Bash", `run check number ${index + 1} of the suite`, "ok"),
      );

    it("cuts the step lines first, keeping the whole report when that is enough", () => {
      const whole = report(3000);
      const activity = [...checks(300), subagent(1000, "fix", 9, whole)];

      const { text } = runDigest(digestInput(eventsOf(), { activity }));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain(`Report: ${whole}`);
      expect(text).toContain("Patched the cookie check.");
      expect(text).not.toContain("run check number 300 of the suite");
    });

    it("shortens the report only after every step line is cut, keeping the reply whole", () => {
      const long = report(14_000);
      const activity = [...checks(5), subagent(1000, "fix", 9, long)];

      const { text } = runDigest(digestInput(eventsOf(), { activity }));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain("Report: Report start.");
      expect(text).not.toContain(long);
      expect(text).not.toContain("run check number 1 of the suite");
      expect(text).toContain("Patched the cookie check.");
    });

    it("shortens the report before the final reply", () => {
      const reply = `Reply start. ${"the patch touched the cookie handler again. ".repeat(180)}`;
      const long = report(6000);
      const activity = [subagent(1000, "fix", 9, long)];

      const { text } = runDigest(digestInput(eventsOf({ reply }), { activity }));

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain(`Final reply: ${reply}`);
      expect(text).toContain("Report: Report start.");
      expect(text).not.toContain(long);
    });

    it("shortens the instructions last, after the reply, the files and the decision texts", () => {
      const instructions = `Instructions start. ${"keep the old cookie path working. ".repeat(150)}`;
      const longAnswer = `Answer start. ${"keep the old cookie for one more release. ".repeat(350)}`;
      const events = eventsOf({ reply: longReply }).map((event) =>
        event.kind === "answered"
          ? ({ ...event, payload: { ...event.payload, answer: longAnswer } } as StoredEvent)
          : event,
      );

      const { text } = runDigest(
        digestInput(events, {
          sources: withInstructions({ fix: instructions }),
          activity: [...files(600), pr],
        }),
      );

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain(`Instructions: ${instructions}`);
      expect(text).not.toContain(longReply);
      expect(text).not.toContain(longAnswer);
      expect(text).toContain("…and 600 more");
    });

    it("shortens instructions longer than the cap and keeps every later stage", () => {
      const instructions = `Instructions start. ${"keep the old cookie path working. ".repeat(600)}`;

      const { text } = runDigest(
        digestInput(eventsOf(), { sources: withInstructions({ fix: instructions }) }),
      );

      expect(text.length).toBeLessThanOrEqual(digestCap);
      expect(text).toContain("Instructions: Instructions start.");
      expect(text).not.toContain(instructions);
      expect(text).toContain("Run the test suite");
      expect(text).toContain(plainReason("verify", failure));
    });
  });
});
