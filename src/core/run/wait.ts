import { z } from "zod";

export const waitRequestSchema = z.discriminatedUnion("kind", [
  z.object({ nodeId: z.string(), kind: z.literal("gate"), shown: z.string() }),
  z.object({
    nodeId: z.string(),
    kind: z.literal("hardstop"),
    shown: z.string(),
    condition: z.string(),
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
  }),
  z.object({
    nodeId: z.string(),
    kind: z.literal("budget"),
    spend: z.number(),
    budget: z.number(),
    unconfirmed: z.literal(true).optional(),
  }),
]);

export type WaitRequest = z.infer<typeof waitRequestSchema>;

const answerableReplySchemas = [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("reject"), reason: z.string() }),
  z.object({ decision: z.literal("continue") }),
  z.object({ decision: z.literal("stop"), reason: z.string() }),
  z.object({ decision: z.literal("answer"), answer: z.string() }),
  z.object({ decision: z.literal("raise"), budget: z.number().positive() }),
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
    case "permission":
      return reply.decision === "approve" || reply.decision === "reject";
    case "hardstop":
      return reply.decision === "continue" || reply.decision === "stop";
    case "ask":
      return (
        reply.decision === "answer" &&
        (request.options.length === 0 || request.options.includes(reply.answer))
      );
    case "budget":
      return (
        reply.decision === "stop" || (reply.decision === "raise" && reply.budget > request.spend)
      );
  }
}

export type HumanWaiter = { wait(request: WaitRequest, signal?: AbortSignal): Promise<WaitReply> };

export type HumanDecision =
  | { nodeId: string; decision: "approved" | "skipped" | "continued" }
  | { nodeId: string; decision: "rejected" | "stopped"; reason: string }
  | { nodeId: string; decision: "answered"; answer: string };

export type HumanOutcome =
  | { status: "done"; line: string; decision: HumanDecision }
  | { status: "failed"; reason: string; decision?: HumanDecision };
