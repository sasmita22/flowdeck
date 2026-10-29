import { z } from "zod";
import type { Flow } from "./schema.js";

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

/**
 * Keeps saved versions of one current flow: the flow of the most recently written version.
 * Saved versions are never changed or deleted.
 */
export interface FlowStore {
  /**
   * Appends the next version to the current flow, or starts a flow named "Untitled" at
   * version 1 when none exists. A new store on the same storage appends to the same flow.
   * Throws when the write fails.
   */
  save(flow: Flow): SavedFlowRef;
  /** The current flow at its highest version, or `null` when nothing has been saved. */
  loadLatest(): LoadedFlow | null;
}

export const saveFlowResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), flowId: z.string(), version: z.number() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export type SaveFlowResult = z.infer<typeof saveFlowResultSchema>;

export type LoadLatestFlowResult =
  { kind: "loaded"; flow: Flow } | { kind: "empty" } | { kind: "error"; message: string };
