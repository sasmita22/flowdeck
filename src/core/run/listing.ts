import { z } from "zod";
import { activityEntrySchema } from "./activity.js";
import { stageSourcesSchema } from "./manifest.js";
import { runSnapshotSchema, snapshotStatusSchema } from "./snapshot.js";

const sourceSchema = z.object({ flowId: z.string(), version: z.number().int() });

export const runSummarySchema = z.object({
  id: z.string(),
  status: snapshotStatusSchema,
  buildId: z.string().optional(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  totalCost: z.number().nullable(),
  nodeCount: z.number().int(),
  source: sourceSchema.optional(),
  buildName: z.string().nullable(),
  blueprintName: z.string().nullable(),
  blueprintVersion: z.number().int().nullable(),
  buildDeleted: z.boolean(),
  number: z.number().int(),
  doneCount: z.number().int(),
  storyLine: z.string().optional(),
});

export type ListedRun = z.infer<typeof runSummarySchema>;

const runHeaderSchema = z.object({
  name: z.string().nullable(),
  blueprintName: z.string().nullable(),
  blueprintVersion: z.number().int().nullable(),
  repo: z.string().nullable(),
  values: z.record(z.string(), z.union([z.string(), z.boolean()])).nullable(),
});

const runStorySchema = z.object({
  header: runHeaderSchema,
  digest: z.string(),
  written: z
    .object({
      text: z.string(),
      at: z.string(),
      runStatus: z.enum(["done", "failed", "stopped"]),
      cost: z.number(),
    })
    .nullable(),
});

export const loadedRunSchema = z.object({
  run: runSummarySchema,
  name: z.string().nullable(),
  stages: stageSourcesSchema.nullable(),
  snapshot: runSnapshotSchema,
  activity: z.array(activityEntrySchema),
  note: z.string().optional(),
  story: runStorySchema.optional(),
});

export type LoadedRun = z.infer<typeof loadedRunSchema>;

export const buildRecordSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  branch: z.string().nullable().optional(),
  branchCreated: z.boolean().nullable().optional(),
  old: z.boolean(),
  dir: z.string(),
  createdAt: z.number(),
  source: sourceSchema.optional(),
  blueprintName: z.string().nullable(),
  blueprintVersion: z.number().int().nullable(),
});

export const snapshotKeySchema = z.union([
  z.object({ pendingId: z.string() }),
  z.object({ buildId: z.string() }),
]);

export const buildPictureSchema = z.object({ svg: z.string().nullable() });

export const buildFileContentSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  content: z.string(),
});

export type BuildFileContent = z.infer<typeof buildFileContentSchema>;

export const buildTreeSchema = z.object({ deleted: z.boolean(), paths: z.array(z.string()) });

export type BuildTree = z.infer<typeof buildTreeSchema>;

export const buildProjectSchema = z.object({
  repoFolder: z.string(),
  path: z.string(),
  branch: z.string(),
  branchCreated: z.boolean(),
  base: z.string(),
  exists: z.boolean(),
  dirty: z.boolean().nullable(),
  unpushed: z.boolean().nullable(),
});

export type BuildProject = z.infer<typeof buildProjectSchema>;

export const buildEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["folder", "file"]),
});

export const buildEntriesSchema = z.array(buildEntrySchema);

export type BuildEntry = z.infer<typeof buildEntrySchema>;

export const pendingBuildTreeSchema = z.object({ paths: z.array(z.string()) });

export type PendingBuildTree = z.infer<typeof pendingBuildTreeSchema>;

export const buildVersionResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("built"), id: z.string(), hash: z.string(), dir: z.string() }),
  z.object({ kind: z.literal("started"), pendingId: z.string() }),
  z.object({
    kind: z.literal("error"),
    message: z.string(),
    problems: z
      .array(
        z.object({ node: z.string().optional(), field: z.string().optional(), text: z.string() }),
      )
      .optional(),
  }),
]);

export type BuildVersionResult = z.infer<typeof buildVersionResultSchema>;
