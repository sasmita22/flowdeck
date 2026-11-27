import { z } from "zod";

const waitRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    nodeId: z.string(),
    kind: z.literal("gate"),
    instruction: z.string(),
    condition: z.string().optional(),
  }),
  z.object({
    nodeId: z.string(),
    kind: z.literal("ask"),
    question: z.string(),
    options: z.array(z.string()),
  }),
  z.object({
    nodeId: z.string(),
    kind: z.literal("permission"),
    tool: z.string(),
    input: z.string(),
    candidates: z.array(z.string()).optional(),
  }),
]);

export type WaitRequest = z.infer<typeof waitRequestSchema>;

const answerableReplySchemas = [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("reject"), reason: z.string() }),
  z.object({ decision: z.literal("continue"), text: z.string().optional() }),
  z.object({ decision: z.literal("stop"), reason: z.string() }),
  z.object({ decision: z.literal("answer"), answer: z.string() }),
] as const;

export const waitReplySchema = z.discriminatedUnion("decision", [
  ...answerableReplySchemas,
  z.object({ decision: z.literal("closed") }),
]);

export type WaitReply = z.infer<typeof waitReplySchema>;

export const pendingWaitSchema = z.object({ waitId: z.string(), request: waitRequestSchema });

export type PendingWait = z.infer<typeof pendingWaitSchema>;

export const waitAnswerSchema = z.object({
  waitId: z.string(),
  reply: z.discriminatedUnion("decision", answerableReplySchemas),
});

export type WaitAnswer = z.infer<typeof waitAnswerSchema>;

export function replyFits(request: WaitRequest, reply: WaitReply): boolean {
  switch (request.kind) {
    case "gate":
      return reply.decision === "continue" || reply.decision === "stop";
    case "permission":
      return reply.decision === "approve" || reply.decision === "reject";
    case "ask":
      return (
        reply.decision === "answer" &&
        (request.options.length === 0 || request.options.includes(reply.answer))
      );
  }
}

export type HumanWaiter = { wait(request: WaitRequest, signal?: AbortSignal): Promise<WaitReply> };

export type HumanDecision =
  | { nodeId: string; decision: "approved" | "skipped" }
  | { nodeId: string; decision: "continued"; text?: string }
  | { nodeId: string; decision: "rejected" | "stopped"; reason: string }
  | { nodeId: string; decision: "answered"; answer: string };

export type HumanOutcome =
  | { status: "done"; line: string; decision: HumanDecision }
  | { status: "failed"; reason: string; decision?: HumanDecision };
