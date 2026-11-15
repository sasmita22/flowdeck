import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import { buildPipelineOf } from "../../../src/core/run/build-pipeline.js";
import type {
  BuildEvent,
  PendingBuild,
  StoredBuildEvent,
} from "../../../src/core/run/build-progress.js";

type Pending = Parameters<typeof buildPipelineOf>[0];
type Pipeline = ReturnType<typeof buildPipelineOf>;

const pending = (over: Partial<PendingBuild> = {}): Pending => ({
  id: "p1",
  name: "nightly",
  startedAt: 90,
  ...over,
});

const stored = (entries: [number, BuildEvent][]): StoredBuildEvent[] =>
  entries.map(([at, event], index) => ({ ...event, seq: index + 1, at }));

const step = (
  n: 1 | 2 | 3 | 4 | 5,
  status: "running" | "done" | "failed",
  extra: { round?: number; message?: string } = {},
): BuildEvent => ({ type: "step", step: n, status, ...extra });

const component = (
  path: string,
  status: "waiting" | "running" | "done" | "failed",
  nodeIds: string[],
  labels?: string[],
): BuildEvent => ({
  type: "component",
  path,
  kind: "agent",
  nodeIds,
  status,
  ...(labels === undefined ? {} : { labels }),
});

const tool = (id: number, nodeId: string, at: number): ActivityEntry => ({
  id,
  nodeId,
  at,
  kind: "tool",
  tool: "Edit",
  summary: `edit ${id}`,
});

const laneOf = (pipeline: Pipeline, n: number, round = 1) => {
  const found = pipeline.lanes.find((lane) => lane.step === n && lane.round === round);
  if (found === undefined) throw new Error(`no lane for step ${n} round ${round}`);
  return found;
};

const rowOf = (pipeline: Pipeline, n: number, round: number, path: string) => {
  const found = laneOf(pipeline, n, round).rows.find((row) => row.path === path);
  if (found === undefined) throw new Error(`no row ${path} in step ${n} round ${round}`);
  return found;
};

const ids = (entries: readonly ActivityEntry[]) => entries.map((entry) => entry.id);

const draft = "plugin/agents/draft-the-fix.md";
const review = "plugin/agents/review-the-fix.md";
const worktree = {
  path: "/home/workspaces/b1/repo",
  branch: "flowdeck/nightly-b1b1b1b1",
  base: "release-1",
};
const unmodelled: BuildEvent = {
  type: "session",
  name: "fd-build-p1",
  claudeSessionId: "c1",
  buildId: "b1",
  repo: "/repo",
  base: "main",
  values: {},
};
const session: BuildEvent = { ...unmodelled, model: "haiku" };

const laidDown: [number, BuildEvent][] = [
  [100, step(1, "running")],
  [110, step(1, "done")],
  [120, step(2, "running")],
  [150, step(2, "done")],
  [160, { type: "worktree", status: "done", ...worktree }],
  [170, session],
];

const twoRounds = stored([
  ...laidDown,
  [200, step(3, "running", { round: 1 })],
  [200, component(draft, "waiting", ["p1"], ["Draft the fix"])],
  [200, component(review, "waiting", ["a"], ["Review the fix"])],
  [210, component(draft, "running", ["p1"], ["Draft the fix"])],
  [250, component(draft, "done", ["p1"], ["Draft the fix"])],
  [260, component(review, "running", ["a"], ["Review the fix"])],
  [290, component(review, "done", ["a"], ["Review the fix"])],
  [300, step(3, "done", { round: 1 })],
  [310, step(4, "running")],
  [320, { type: "merge", nodeIds: ["p1", "a"], piece: draft }],
  [330, component(draft, "running", ["p1", "a"], ["Draft the fix", "Review the fix"])],
  [340, component(draft, "done", ["p1", "a"], ["Draft the fix", "Review the fix"])],
  [350, step(4, "done")],
  [360, step(5, "running", { round: 1 })],
  [380, step(5, "failed", { round: 1, message: "frontmatter missing" })],
  [380, { type: "check-failed", round: 1, failures: [`${review}: frontmatter missing`] }],
  [400, step(3, "running", { round: 2 })],
  [400, component(review, "waiting", ["a"], ["Review the fix"])],
  [410, component(review, "running", ["a"], ["Review the fix"])],
  [450, component(review, "done", ["a"], ["Review the fix"])],
  [470, step(3, "done", { round: 2 })],
  [480, step(5, "running", { round: 2 })],
  [500, step(5, "done", { round: 2 })],
  [510, { type: "cost", inputTokens: 1200, outputTokens: 300, usd: 0.04 }],
]);

const twoRoundsActivity: ActivityEntry[] = [
  tool(1, draft, 200),
  tool(2, review, 270),
  tool(3, draft, 335),
  tool(4, "audit", 390),
  tool(5, review, 420),
  tool(6, draft, 430),
];

const built = () =>
  buildPipelineOf(
    pending({ endedAt: 520, outcome: "built", buildId: "b1" }),
    twoRounds,
    twoRoundsActivity,
  );

describe("buildPipelineOf", () => {
  describe("before anything runs", () => {
    it("has all five stages waiting in round 1, with no rows and no log", () => {
      const pipeline = buildPipelineOf(pending(), [], []);

      expect(pipeline.lanes).toHaveLength(5);
      for (const n of [1, 2, 3, 4, 5]) {
        expect(laneOf(pipeline, n)).toEqual(
          expect.objectContaining({ step: n, round: 1, status: "waiting", rows: [], log: [] }),
        );
      }
    });

    it("has no rows before step 3 starts, while the stages after it wait", () => {
      const pipeline = buildPipelineOf(pending(), stored(laidDown), []);

      expect(laneOf(pipeline, 1).status).toBe("done");
      expect(laneOf(pipeline, 2).status).toBe("done");
      expect(laneOf(pipeline, 3).status).toBe("waiting");
      expect(laneOf(pipeline, 4).status).toBe("waiting");
      expect(laneOf(pipeline, 5).status).toBe("waiting");
      expect(pipeline.lanes.flatMap((lane) => lane.rows)).toEqual([]);
    });
  });

  describe("rounds", () => {
    it("keeps each Write and Verify round as its own lane with its own status and duration", () => {
      const pipeline = built();

      expect(laneOf(pipeline, 3, 1)).toEqual(
        expect.objectContaining({ status: "done", durationMs: 100 }),
      );
      expect(laneOf(pipeline, 3, 2)).toEqual(
        expect.objectContaining({ status: "done", durationMs: 70 }),
      );
      expect(laneOf(pipeline, 5, 1)).toEqual(
        expect.objectContaining({ status: "failed", durationMs: 20 }),
      );
      expect(laneOf(pipeline, 5, 2)).toEqual(
        expect.objectContaining({ status: "done", durationMs: 20 }),
      );
    });

    it("gives round 1's Verify the check's failures and round 2's none", () => {
      const pipeline = built();

      expect(laneOf(pipeline, 5, 1).failures).toEqual([`${review}: frontmatter missing`]);
      expect(laneOf(pipeline, 5, 2).failures ?? []).toEqual([]);
    });

    it("has Check hand-offs, Check and Lay down once, in round 1", () => {
      const pipeline = built();

      for (const n of [1, 2, 4]) {
        expect(pipeline.lanes.filter((lane) => lane.step === n).map((lane) => lane.round)).toEqual([
          1,
        ]);
      }
    });
  });

  describe("the worktree", () => {
    it("shows a failed worktree as a failed sub-step of Lay down, which stays done", () => {
      const failed = { ...worktree, base: "no-such-branch" };
      const pipeline = buildPipelineOf(
        pending({ endedAt: 170, outcome: "failed" }),
        stored([
          [100, step(1, "running")],
          [110, step(1, "done")],
          [120, step(2, "running")],
          [150, step(2, "done")],
          [
            160,
            {
              type: "worktree",
              status: "failed",
              ...failed,
              message: "fatal: invalid reference: no-such-branch",
            },
          ],
        ]),
        [],
      );

      const layDown = laneOf(pipeline, 2);
      expect(layDown.status).toBe("done");
      expect(layDown.worktree).toEqual({
        status: "failed",
        ...failed,
        message: "fatal: invalid reference: no-such-branch",
      });
      expect(pipeline.header.status).toBe("failed");
    });

    it("shows the worktree it cut as a done sub-step of Lay down", () => {
      expect(laneOf(built(), 2).worktree).toEqual({ status: "done", ...worktree });
    });

    it("has no worktree sub-step for a build with no worktree event", () => {
      const pipeline = buildPipelineOf(
        pending(),
        stored(laidDown.filter(([, event]) => event.type !== "worktree")),
        [],
      );

      expect(laneOf(pipeline, 2).worktree).toBeUndefined();
    });
  });

  describe("rows", () => {
    it("has one row per component path in each Write round and in Check hand-offs, with its latest status there", () => {
      const pipeline = built();

      expect(
        laneOf(pipeline, 3, 1)
          .rows.map((row) => row.path)
          .sort(),
      ).toEqual([draft, review].sort());
      expect(laneOf(pipeline, 3, 2).rows.map((row) => row.path)).toEqual([review]);
      expect(laneOf(pipeline, 4).rows.map((row) => row.path)).toEqual([draft]);
      expect(rowOf(pipeline, 3, 1, review)).toEqual(
        expect.objectContaining({
          kind: "agent",
          status: "done",
          labels: ["Review the fix"],
          merged: false,
        }),
      );
      expect(laneOf(pipeline, 1).rows).toEqual([]);
      expect(laneOf(pipeline, 2).rows).toEqual([]);
      expect(laneOf(pipeline, 5, 1).rows).toEqual([]);
    });

    it("shows a row's status at the moment within its round", () => {
      const pipeline = buildPipelineOf(
        pending(),
        stored([
          ...laidDown,
          [200, step(3, "running", { round: 1 })],
          [200, component(draft, "waiting", ["p1"], ["Draft the fix"])],
          [200, component(review, "waiting", ["a"], ["Review the fix"])],
          [210, component(draft, "running", ["p1"], ["Draft the fix"])],
        ]),
        [],
      );

      expect(rowOf(pipeline, 3, 1, draft).status).toBe("running");
      expect(rowOf(pipeline, 3, 1, review).status).toBe("waiting");
    });

    it("marks the merged piece's row merged, with every merged node's label", () => {
      expect(rowOf(built(), 4, 1, draft)).toEqual(
        expect.objectContaining({
          status: "done",
          labels: ["Draft the fix", "Review the fix"],
          merged: true,
        }),
      );
    });

    it("falls back to the node ids when the component event carries no labels", () => {
      const pipeline = buildPipelineOf(
        pending(),
        stored([
          ...laidDown,
          [200, step(3, "running", { round: 1 })],
          [200, component(draft, "waiting", ["p1", "p2"])],
        ]),
        [],
      );

      expect(rowOf(pipeline, 3, 1, draft).labels).toEqual(["p1", "p2"]);
    });
  });

  describe("logs", () => {
    it("gives a lane the activity inside its running-to-closing window, ends included", () => {
      const pipeline = built();

      expect(ids(laneOf(pipeline, 3, 1).log)).toEqual([1, 2]);
      expect(ids(laneOf(pipeline, 4).log)).toEqual([3]);
      expect(ids(laneOf(pipeline, 3, 2).log)).toEqual([5, 6]);
      expect(pipeline.lanes.flatMap((lane) => ids(lane.log))).not.toContain(4);
    });

    it("narrows a row's log to its own component's activity within its round", () => {
      const pipeline = built();

      expect(ids(rowOf(pipeline, 3, 1, draft).log)).toEqual([1]);
      expect(ids(rowOf(pipeline, 3, 1, review).log)).toEqual([2]);
      expect(ids(rowOf(pipeline, 3, 2, review).log)).toEqual([5]);
      expect(ids(rowOf(pipeline, 4, 1, draft).log)).toEqual([3]);
    });

    it("keeps a running lane's window open", () => {
      const pipeline = buildPipelineOf(
        pending(),
        stored([
          ...laidDown,
          [200, step(3, "running", { round: 1 })],
          [200, component(draft, "waiting", ["p1"], ["Draft the fix"])],
        ]),
        [tool(1, draft, 150), tool(2, draft, 250), tool(3, draft, 9_000)],
      );

      expect(ids(laneOf(pipeline, 3, 1).log)).toEqual([2, 3]);
      expect(ids(rowOf(pipeline, 3, 1, draft).log)).toEqual([2, 3]);
    });

    it("gives a failed stage its message", () => {
      const pipeline = buildPipelineOf(
        pending({ endedAt: 260, outcome: "failed" }),
        stored([
          ...laidDown,
          [200, step(3, "running", { round: 1 })],
          [250, step(3, "failed", { round: 1, message: "The build session's turn failed: gone" })],
        ]),
        [],
      );

      expect(laneOf(pipeline, 3, 1)).toEqual(
        expect.objectContaining({
          status: "failed",
          message: "The build session's turn failed: gone",
        }),
      );
      expect(laneOf(built(), 5, 1).message).toBe("frontmatter missing");
    });
  });

  describe("the header", () => {
    it("has the build's name, times, status, repo, worktree, model and latest cost", () => {
      expect(built().header).toEqual(
        expect.objectContaining({
          name: "nightly",
          startedAt: 90,
          endedAt: 520,
          status: "built",
          repo: "/repo",
          branch: worktree.branch,
          path: worktree.path,
          base: worktree.base,
          model: "haiku",
          cost: { inputTokens: 1200, outputTokens: 300, usd: 0.04 },
        }),
      );
    });

    it.each<[PendingBuild["outcome"], string]>([
      [undefined, "building"],
      ["needs-you", "needs-you"],
      ["failed", "failed"],
      ["stopped", "stopped"],
    ])("reads outcome %s as %s", (outcome, status) => {
      const pipeline = buildPipelineOf(
        pending(outcome === undefined ? {} : { outcome, endedAt: 200 }),
        stored(laidDown),
        [],
      );

      expect(pipeline.header.status).toBe(status);
    });

    it("takes the base from the session when there is no worktree event, and no model when the session names none", () => {
      const pipeline = buildPipelineOf(
        pending(),
        stored([
          [100, step(1, "running")],
          [110, step(1, "done")],
          [120, step(2, "running")],
          [150, step(2, "done")],
          [170, unmodelled],
        ]),
        [],
      );

      expect(pipeline.header).toEqual(expect.objectContaining({ repo: "/repo", base: "main" }));
      expect(pipeline.header.branch).toBeUndefined();
      expect(pipeline.header.path).toBeUndefined();
      expect(pipeline.header.model).toBeUndefined();
      expect(pipeline.header.cost).toBeUndefined();
    });
    const cutOn = (branchCreated: boolean | undefined) =>
      buildPipelineOf(
        pending(),
        stored([
          ...laidDown.filter(([, event]) => event.type !== "worktree"),
          [
            160,
            {
              type: "worktree",
              status: "done",
              ...worktree,
              ...(branchCreated === undefined ? {} : { branchCreated }),
            },
          ],
        ]),
        [],
      ).header;

    it("shows the branch and no base for a worktree on a branch it did not create", () => {
      const header = cutOn(false);

      expect(header.branch).toBe(worktree.branch);
      expect(header.base ?? null).toBeNull();
    });

    it.each([
      ["recorded before builds said whether they made the branch", undefined],
      ["on a branch it created", true],
    ])("shows the branch and its base for a worktree %s", (_label, branchCreated) => {
      expect(cutOn(branchCreated)).toEqual(
        expect.objectContaining({ branch: worktree.branch, base: worktree.base }),
      );
    });
  });

  describe("needs you", () => {
    it("blocks the lane of the latest step event", () => {
      const pipeline = buildPipelineOf(
        pending({ endedAt: 360, outcome: "needs-you" }),
        stored([
          ...laidDown,
          [200, step(3, "running", { round: 1 })],
          [300, step(3, "done", { round: 1 })],
          [310, step(4, "running")],
          [350, step(4, "done")],
        ]),
        [],
      );

      expect(pipeline.blockedLane).toEqual({ step: 4, round: 1 });
    });

    it("blocks no lane when the build does not need you", () => {
      expect(built().blockedLane).toBeUndefined();
      expect(buildPipelineOf(pending(), stored(laidDown), []).blockedLane).toBeUndefined();
    });
  });
});
