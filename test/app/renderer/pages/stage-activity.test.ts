import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../../../src/core/run/activity.js";
import type { PipelineStage } from "../../../../src/core/run/pipeline.js";
import { selectStageActivity as select } from "../../../../src/app/renderer/pages/stage-activity.js";
import { tool } from "../../../fixtures/activity-entries.js";

const entry = (id: number, nodeId: string): ActivityEntry => ({ ...tool(id), nodeId });

const stage = (nodeId: string, window: { activityFrom?: number; activityTo?: number } = {}) =>
  ({
    nodeId,
    type: "agent",
    label: nodeId,
    status: "running",
    retries: 0,
    decisions: [],
    budgetPauses: [],
    timeline: [],
    activity: [],
    ...window,
  }) as PipelineStage;

describe("selectStageActivity", () => {
  it("returns the same array for the same entries and stage", () => {
    const entries = [entry(3, "a"), entry(2, "b"), entry(1, "a")];
    const a = stage("a");

    expect(select(entries, a)).toBe(select(entries, a));
  });

  it("gives a new result holding a newly pushed entry and an in-place update", () => {
    const a = stage("a");
    const before = [entry(2, "a"), entry(1, "a")];
    const first = select(before, a);
    const finished = { ...entry(2, "a"), result: "ok" } as ActivityEntry;
    const after = [entry(3, "a"), finished, entry(1, "a")];

    const second = select(after, a);

    expect(second).not.toBe(first);
    expect(second).toEqual([entry(3, "a"), finished, entry(1, "a")]);
  });

  it("keeps the input's newest-first order and the stage's window", () => {
    const entries = [entry(1, "a"), entry(5, "a"), entry(3, "a"), entry(4, "b")];

    expect(select(entries, stage("a"))).toEqual([entry(1, "a"), entry(5, "a"), entry(3, "a")]);
    expect(select(entries, stage("a", { activityFrom: 1001, activityTo: 1005 }))).toEqual([
      entry(5, "a"),
      entry(3, "a"),
    ]);
  });

  it("gives a different stage its own result for the same entries", () => {
    const entries = [entry(2, "b"), entry(1, "a")];

    expect(select(entries, stage("a"))).toEqual([entry(1, "a")]);
    expect(select(entries, stage("b"))).toEqual([entry(2, "b")]);
  });
});
