import type { ActivityEntry } from "../../../core/run/activity.js";
import { stageActivityOf, type PipelineStage } from "../../../core/run/pipeline.js";

const selected = new WeakMap<readonly ActivityEntry[], WeakMap<PipelineStage, ActivityEntry[]>>();

export const selectStageActivity = (
  entries: readonly ActivityEntry[],
  stage: PipelineStage,
): ActivityEntry[] => {
  let byStage = selected.get(entries);
  if (byStage === undefined) {
    byStage = new WeakMap();
    selected.set(entries, byStage);
  }
  const cached = byStage.get(stage);
  if (cached !== undefined) return cached;
  const shown = stageActivityOf(entries, stage);
  byStage.set(stage, shown);
  return shown;
};
