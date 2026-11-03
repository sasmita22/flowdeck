import { z } from "zod";
import { Flow } from "../flow/schema.js";
import { activityEntrySchema } from "./activity.js";
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
});

export type ListedRun = z.infer<typeof runSummarySchema>;

export const loadedRunSchema = z.object({
  run: runSummarySchema,
  name: z.string().nullable(),
  flow: Flow.nullable(),
  snapshot: runSnapshotSchema,
  activity: z.array(activityEntrySchema),
  note: z.string().optional(),
});

export type LoadedRun = z.infer<typeof loadedRunSchema>;

export const buildRecordSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  old: z.boolean(),
  dir: z.string(),
  createdAt: z.number(),
  source: sourceSchema.optional(),
});

export const buildFileContentSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  content: z.string(),
});

export type BuildFileContent = z.infer<typeof buildFileContentSchema>;

export const buildVersionResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("built"), id: z.string(), hash: z.string(), dir: z.string() }),
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
