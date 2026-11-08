import { z } from "zod";

const nodeGroup = z.strictObject({
  nodeIds: z.array(z.string()).min(2),
  reason: z.string(),
});

const buildQuestionSchema = z.strictObject({
  nodeId: z.string(),
  text: z.string(),
  otherNodeId: z.string().optional(),
});

export const buildAnswerSchema = buildQuestionSchema.extend({
  answer: z.string().trim().min(1),
});

export type BuildAnswer = z.infer<typeof buildAnswerSchema>;

export const buildReportSchema = z.strictObject({
  version: z.literal(1),
  questions: z.array(buildQuestionSchema),
  merges: z.array(nodeGroup),
  keptApart: z.array(nodeGroup),
  mixedJobs: z.array(z.strictObject({ nodeId: z.string(), note: z.string() })),
  pieces: z.array(
    z.strictObject({
      path: z.string(),
      status: z.enum(["done", "question"]),
    }),
  ),
});

export type BuildReport = z.infer<typeof buildReportSchema>;

export function emptyReport(): BuildReport {
  return { version: 1, questions: [], merges: [], keptApart: [], mixedJobs: [], pieces: [] };
}

export class BuildReportParseError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super(z.prettifyError(error));
    this.name = "BuildReportParseError";
    this.issues = error.issues;
  }
}

export function parseBuildReport(text: string): BuildReport {
  const result = buildReportSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new BuildReportParseError(result.error);
  return result.data;
}
