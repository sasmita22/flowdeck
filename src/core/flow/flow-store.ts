import { z } from "zod";
import {
  blueprintKind,
  expandedOrAsIs,
  kindResolver,
  libraryUses,
  reachedSessions,
  type LibraryResolver,
} from "./libraries.js";
import { BuildConfig, Flow, SessionContainer } from "./schema.js";
import { FoundVariable, foundVariables, groupVariables } from "./variables.js";

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
  variables: z.array(FoundVariable),
  pinned: z.boolean(),
  kind: z.enum(["workflow", "node-library", "session-library", "incomplete"]),
  sessions: z.array(
    SessionContainer.pick({ id: true, name: true, repo: true, branch: true, model: true }),
  ),
  uses: z.array(z.string()),
});

export type FlowSummary = z.infer<typeof flowSummarySchema>;

type BlueprintFacts = Pick<FlowSummary, "kind" | "variables" | "sessions" | "uses">;

export function blueprintFacts(flow: Flow, resolve: LibraryResolver): BlueprintFacts {
  const kind = blueprintKind(flow, kindResolver(resolve));
  const expanded = expandedOrAsIs(flow, resolve);
  return {
    kind,
    variables: groupVariables(foundVariables(expanded.flow), expanded.uses),
    sessions:
      kind === "node-library" || kind === "session-library" ? reachedSessions(expanded.flow) : [],
    uses: libraryUses(flow),
  };
}

export const noBlueprintFacts: BlueprintFacts = {
  kind: "incomplete",
  variables: [],
  sessions: [],
  uses: [],
};

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
  delete(flowId: string): void;
  isDeleted(flowId: string): boolean;
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

export const latestLibraries =
  (flows: Pick<FlowStore, "loadLatest">): LibraryResolver =>
  (flowId) => {
    const library = flows.loadLatest(flowId);
    return library === null ? undefined : { name: library.name, flow: library.flow };
  };

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
