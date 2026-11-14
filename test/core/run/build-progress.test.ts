import { describe, expect, it } from "vitest";
import {
  buildEventSchema,
  buildingCardOf,
  buildProgressEntrySchema,
  progressOf,
  type BuildEvent,
  type BuildProgressEntry,
  type BuildOutcome,
  type PendingBuild,
  type StoredBuildEvent,
} from "../../../src/core/run/build-progress.js";

const pending = (over: Partial<PendingBuild> = {}): PendingBuild => ({
  id: "p1",
  flowId: "f1",
  version: 4,
  name: "nightly",
  origin: { kind: "blueprint" },
  startedAt: 1_000,
  ...over,
});

const stored = (entries: [number, BuildEvent][]): StoredBuildEvent[] =>
  entries.map(([at, event], index) => ({ ...event, seq: index + 1, at }));

const step = (
  n: 1 | 2 | 3 | 4 | 5,
  status: "running" | "done" | "failed" | "skipped",
  round?: number,
): BuildEvent => ({ type: "step", step: n, status, ...(round === undefined ? {} : { round }) });

const component = (
  path: string,
  nodeIds: string[],
  status: "waiting" | "running" | "done" | "failed",
): BuildEvent => ({ type: "component", path, kind: "agent", nodeIds, status });

describe("buildEventSchema", () => {
  it.each<[string, BuildEvent]>([
    ["a step", { type: "step", step: 3, status: "running" }],
    ["a step in a round", { type: "step", step: 5, status: "failed", round: 2 }],
    ["a skipped step", { type: "step", step: 4, status: "skipped" }],
    [
      "a failed step with its message",
      { type: "step", step: 5, status: "failed", message: "git said no" },
    ],
    [
      "a component",
      { type: "component", path: "agents/a.md", kind: "agent", nodeIds: ["n1"], status: "waiting" },
    ],
    [
      "a shared component",
      {
        type: "component",
        path: "plugin/skills/repo-conventions/SKILL.md",
        kind: "shared",
        nodeIds: [],
        status: "waiting",
      },
    ],
    [
      "a workspace component",
      { type: "component", path: ".", kind: "workspace", nodeIds: [], status: "done" },
    ],
    [
      "a session",
      {
        type: "session",
        name: "fd-build-p1",
        claudeSessionId: "c1",
        buildId: "b1",
        repo: "/repo",
        base: "main",
        values: { ticket: "FD-1", dry: true },
      },
    ],
    [
      "a component with its node labels",
      {
        type: "component",
        path: "agents/a.md",
        kind: "agent",
        nodeIds: ["n1", "n2"],
        labels: ["Draft the fix", "Review the fix"],
        status: "running",
      },
    ],
    [
      "a session with its build model",
      {
        type: "session",
        name: "fd-build-p1",
        claudeSessionId: "c1",
        buildId: "b1",
        repo: "/repo",
        base: "main",
        values: {},
        model: "haiku",
      },
    ],
    [
      "a worktree cut",
      {
        type: "worktree",
        status: "done",
        path: "/home/workspaces/b1/repo",
        branch: "flowdeck/nightly-b1b1b1b1",
        base: "main",
      },
    ],
    [
      "a worktree that could not be cut, with git's message",
      {
        type: "worktree",
        status: "failed",
        path: "/home/workspaces/b1/repo",
        branch: "flowdeck/nightly-b1b1b1b1",
        base: "no-such-branch",
        message: "fatal: invalid reference: no-such-branch",
      },
    ],
    ["a failed check", { type: "check-failed", round: 1, failures: ["frontmatter"] }],
    ["a merge", { type: "merge", nodeIds: ["n1", "n2"], piece: "skills/shared/SKILL.md" }],
    ["a cost", { type: "cost", inputTokens: 120, outputTokens: 30, usd: 0.02 }],
  ])("accepts %s", (_name, event) => {
    expect(buildEventSchema.safeParse(event)).toEqual({ success: true, data: event });
  });

  it.each<[string, unknown]>([
    ["step 0", { type: "step", step: 0, status: "running" }],
    ["step 6", { type: "step", step: 6, status: "done" }],
    ["an unknown step status", { type: "step", step: 1, status: "waiting" }],
    [
      "an unknown component kind",
      { type: "component", path: "x", kind: "plugin", nodeIds: [], status: "done" },
    ],
    [
      "an unknown component status",
      { type: "component", path: "x", kind: "agent", nodeIds: [], status: "skipped" },
    ],
    [
      "a step component",
      { type: "component", path: "x", kind: "step", nodeIds: [], status: "done" },
    ],
    [
      "a script component",
      { type: "component", path: "x", kind: "script", nodeIds: [], status: "done" },
    ],
    ["an unknown event type", { type: "teleport" }],
  ])("rejects %s", (_name, event) => {
    expect(buildEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("progressOf", () => {
  it("lists the five steps, waiting, before any event", () => {
    expect(progressOf(pending(), []).steps).toEqual([
      { step: 1, status: "waiting" },
      { step: 2, status: "waiting" },
      { step: 3, status: "waiting" },
      { step: 4, status: "waiting" },
      { step: 5, status: "waiting" },
    ]);
  });

  it("gives each step its latest status and the time it took", () => {
    const events = stored([
      [1_000, step(1, "running")],
      [1_200, step(1, "done")],
      [1_200, step(2, "running")],
      [4_700, step(2, "done")],
      [4_700, step(3, "skipped")],
      [4_700, step(4, "skipped")],
      [4_800, step(5, "running", 1)],
      [5_100, step(5, "failed", 1)],
    ]);

    expect(progressOf(pending(), events).steps).toEqual([
      { step: 1, status: "done", tookMs: 200 },
      { step: 2, status: "done", tookMs: 3_500 },
      { step: 3, status: "skipped" },
      { step: 4, status: "skipped" },
      { step: 5, status: "failed", round: 1, tookMs: 300 },
    ]);
  });

  it("keeps the message of a failed step", () => {
    const events = stored([
      [1_000, step(5, "running")],
      [1_300, { type: "step", step: 5, status: "failed", message: "git said no" }],
    ]);

    expect(progressOf(pending(), events).steps[4]).toEqual({
      step: 5,
      status: "failed",
      tookMs: 300,
      message: "git said no",
    });
  });

  it("times a step from its first start to its end across rounds", () => {
    const events = stored([
      [2_000, step(5, "running", 1)],
      [2_400, step(5, "running", 2)],
      [3_000, step(5, "done", 2)],
    ]);

    expect(progressOf(pending(), events).steps[4]).toEqual({
      step: 5,
      status: "done",
      round: 2,
      tookMs: 1_000,
    });
  });

  it("keeps the latest status of each component, in first-seen order", () => {
    const events = stored([
      [1, component("agents/a.md", ["n1"], "waiting")],
      [2, component("skills/b/SKILL.md", ["n2", "n3"], "waiting")],
      [3, component("agents/a.md", ["n1"], "running")],
      [4, component("agents/a.md", ["n1"], "done")],
    ]);

    expect(progressOf(pending(), events).components).toEqual([
      { path: "agents/a.md", kind: "agent", nodeIds: ["n1"], status: "done" },
      { path: "skills/b/SKILL.md", kind: "agent", nodeIds: ["n2", "n3"], status: "waiting" },
    ]);
  });

  it("gives the latest cost", () => {
    const events = stored([
      [1, { type: "cost", inputTokens: 10, outputTokens: 2, usd: 0.01 }],
      [2, step(2, "running")],
      [3, { type: "cost", inputTokens: 90, outputTokens: 20, usd: 0.05 }],
    ]);

    expect(progressOf(pending(), events).cost).toEqual({
      inputTokens: 90,
      outputTokens: 20,
      usd: 0.05,
    });
  });

  it("has no cost before a cost event", () => {
    expect(progressOf(pending(), stored([[1, step(1, "running")]])).cost).toBeUndefined();
  });

  it("shows the running step on an open build", () => {
    const events = stored([
      [1, step(1, "running")],
      [2, step(1, "done")],
      [3, step(2, "running")],
      [4, step(2, "done")],
      [5, step(3, "running")],
    ]);

    expect(progressOf(pending(), events).chip).toBe("Building · step 3 of 5");
  });

  it.each<[BuildOutcome, string, string]>([
    ["built", "Built · v4", "Built · v4"],
    ["needs-you", "Needs you", "Needs you"],
    ["failed", "Failed", "Failed"],
    ["stopped", "Failed", "Stopped"],
  ])("ends %s with the chip %s and the label %s", (outcome, chip, outcomeLabel) => {
    const ended = pending({ endedAt: 9_000, outcome });
    const events = stored([
      [1, step(1, "running")],
      [2, step(1, "done")],
    ]);

    expect(progressOf(ended, events)).toMatchObject({ chip, outcomeLabel });
  });

  it("names the version the build was for", () => {
    const ended = pending({ version: 7, endedAt: 9_000, outcome: "built", buildId: "b1" });

    expect(progressOf(ended, []).chip).toBe("Built · v7");
  });
});

describe("progressOf questions", () => {
  const report = (questions: unknown[]) => ({
    version: 1,
    questions,
    merges: [],
    keptApart: [],
    mixedJobs: [],
    pieces: [],
    needs: [],
    shared: [],
  });

  it("carries the report's questions, each naming its node and the other node", () => {
    const questions = [
      { nodeId: "n1", text: "Who writes notes.md?", otherNodeId: "n0" },
      { nodeId: "n2", text: "Which repo?" },
    ];

    const progress = progressOf(pending({ outcome: "needs-you", report: report(questions) }), []);

    expect(progress.questions).toEqual(questions);
  });

  it.each<[BuildOutcome | undefined, boolean]>([
    ["needs-you", true],
    ["failed", false],
    ["stopped", false],
    [undefined, false],
  ])("lets a build that ended %s with questions be answered: %s", (outcome, answerable) => {
    const asked = report([{ nodeId: "n1", text: "Which repo?" }]);
    const build = pending({
      report: asked,
      ...(outcome === undefined ? {} : { endedAt: 9_000, outcome }),
    });

    expect(progressOf(build, []).answerable === true).toBe(answerable);
  });

  it("has no questions without a report, or with a report that asks none", () => {
    expect(progressOf(pending(), [])).not.toHaveProperty("questions");
    expect(progressOf(pending({ outcome: "built", report: report([]) }), [])).not.toHaveProperty(
      "questions",
    );
  });
});

const entry = (over: Partial<BuildProgressEntry> = {}): BuildProgressEntry => ({
  pendingId: "p1",
  name: "fix-a",
  startedAt: 1_000,
  events: [],
  progress: progressOf(pending(), []),
  ...over,
});

describe("buildingCardOf", () => {
  it("names the build, its blueprint and version, and when it started", () => {
    const card = buildingCardOf(
      entry({ blueprintName: "Nightly triage", blueprintVersion: 3, startedAt: 5_000 }),
    );

    expect(card).toEqual({
      pendingId: "p1",
      buildName: "fix-a",
      blueprintName: "Nightly triage",
      blueprintVersion: 3,
      startedAt: 5_000,
      badge: "Building · step 1 of 5",
      live: true,
    });
  });

  it("shows the step of the latest step event on an open build", () => {
    const events = stored([
      [1, step(1, "running")],
      [2, step(1, "done")],
      [3, step(2, "running")],
      [4, step(2, "done")],
      [5, step(3, "running", 1)],
    ]);

    expect(buildingCardOf(entry({ events }))?.badge).toBe("Building · step 3 of 5");
  });

  it("shows step 1 before any step event", () => {
    expect(buildingCardOf(entry())?.badge).toBe("Building · step 1 of 5");
  });

  it.each<[Exclude<BuildOutcome, "built">, string]>([
    ["needs-you", "Needs you"],
    ["failed", "Failed"],
    ["stopped", "Stopped"],
  ])("badges a build that ended %s as %s, not live", (outcome, badge) => {
    const events = stored([[1, step(3, "running", 1)]]);

    expect(buildingCardOf(entry({ events, endedAt: 9_000, outcome }))).toMatchObject({
      badge,
      live: false,
    });
  });

  it("has no card for a build that ended built", () => {
    expect(
      buildingCardOf(entry({ endedAt: 9_000, outcome: "built", buildId: "b1" })),
    ).toBeUndefined();
  });

  it("has no blueprint name or version when the entry has none", () => {
    const card = buildingCardOf(entry());

    expect(card).not.toHaveProperty("blueprintName");
    expect(card).not.toHaveProperty("blueprintVersion");
  });
});

describe("buildProgressEntrySchema", () => {
  it("parses an entry with no blueprint id", () => {
    expect(buildProgressEntrySchema.safeParse(entry())).toEqual({ success: true, data: entry() });
  });

  it("strips a blueprint id the entry still carries", () => {
    const parsed = buildProgressEntrySchema.parse({ ...entry(), flowId: "f1" });

    expect(parsed).not.toHaveProperty("flowId");
  });

  it("keeps each event with its seq and time", () => {
    const events = stored([
      [1_000, step(1, "running")],
      [1_200, component("agents/a.md", ["n1"], "running")],
    ]);
    const ended = entry({
      events,
      endedAt: 9_000,
      outcome: "failed",
      blueprintName: "Nightly triage",
      blueprintVersion: 3,
    });

    expect(buildProgressEntrySchema.parse(ended)).toEqual(ended);
  });
});
