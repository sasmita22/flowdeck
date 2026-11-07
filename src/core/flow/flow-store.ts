import { z } from "zod";
import { BuildConfig, Flow } from "./schema.js";

export interface SavedFlowRef {
  flowId: string;
  version: number;
}

export interface LoadedFlow {
  flowId: string;
  name: string;
  version: number;
  flow: Flow;
}

export interface NewBlueprint {
  name: string;
}

export const flowSummarySchema = z.object({
  flowId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  versions: z.number().int(),
  lastSavedAt: z.string().nullable(),
  buildConfig: BuildConfig.nullable(),
  pinned: z.boolean(),
});

export type FlowSummary = z.infer<typeof flowSummarySchema>;

/**
 * Keeps named blueprints and their saved versions. Saved versions are never changed or deleted;
 * only a blueprint's name changes.
 */
export interface FlowStore {
  create(name: string): FlowSummary;
  /** Every blueprint, the most recently saved or created first. */
  list(): FlowSummary[];
  /** Throws when the blueprint does not exist or the name is blank. */
  rename(flowId: string, name: string): void;
  pin(flowId: string, pinned: boolean): void;
  /**
   * Appends the next version to the blueprint `target` names, or creates a blueprint named
   * `target.name` with this as its version 1, all or nothing. Without a target, appends to the
   * flow of the most recently written version, starting a flow named "Untitled" when none
   * exists. Throws when the write fails, the name is blank or the id names no blueprint.
   */
  save(flow: Flow, target?: string | NewBlueprint): SavedFlowRef;
  /** The highest version of `flowId` (or of the most recently saved flow), or `null`. */
  loadLatest(flowId?: string): LoadedFlow | null;
  load(ref: SavedFlowRef): LoadedFlow | null;
}

export const saveFlowResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), flowId: z.string(), version: z.number() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export type SaveFlowResult = z.infer<typeof saveFlowResultSchema>;

export const openedFlowSchema = z.object({
  flowId: z.string(),
  name: z.string(),
  version: z.number().int().nullable(),
  flow: Flow.nullable(),
});

export type OpenedFlow = z.infer<typeof openedFlowSchema>;
