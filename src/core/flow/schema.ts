import { z } from "zod";
import { settings as agent } from "../nodes/agent/settings.js";
import { settings as ask } from "../nodes/ask/settings.js";
import { settings as gate } from "../nodes/gate/settings.js";
import { settings as hardstop } from "../nodes/hardstop/settings.js";
import { settings as loop } from "../nodes/loop/settings.js";
import { settings as output } from "../nodes/output/settings.js";
import { settings as prompt } from "../nodes/prompt/settings.js";
import { settings as script } from "../nodes/script/settings.js";
import { settings as trigger } from "../nodes/trigger/settings.js";

export const NodeType = z.enum([
  "prompt",
  "script",
  "agent",
  "gate",
  "ask",
  "hardstop",
  "loop",
  "trigger",
  "output",
]);

export const WireKind = z.enum(["then", "file", "event"]);

export const Port = z.object({
  name: z.string(),
  direction: z.enum(["in", "out"]),
  kind: WireKind,
});

const Endpoint = z.object({ node: z.string(), port: z.string() });
const wireEnds = { from: Endpoint, to: Endpoint };

export const Wire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("then"), ...wireEnds }),
  z.object({ kind: z.literal("file"), ...wireEnds, file: z.string().min(1) }),
  z.object({ kind: z.literal("event"), ...wireEnds }),
]);

export const Session = z.object({
  name: z.string(),
  workingFolder: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("path"), path: z.string() }),
    z.object({ kind: z.literal("worktree"), branch: z.string(), repo: z.string().optional() }),
  ]),
  model: z.string(),
  allowedTools: z.array(z.string()),
  permissionMode: z.string(),
  connectors: z.array(z.string()),
  frame: z.object({ nodes: z.array(z.string()) }).optional(),
  budget: z.number().positive().optional(),
});

const NodeBase = z.object({
  id: z.string().min(1),
  label: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  parent: z.string().optional(),
});

export const Node = z.discriminatedUnion("type", [
  NodeBase.extend({ type: z.literal("prompt"), settings: prompt }),
  NodeBase.extend({ type: z.literal("script"), settings: script }),
  NodeBase.extend({ type: z.literal("agent"), settings: agent }),
  NodeBase.extend({ type: z.literal("gate"), settings: gate }),
  NodeBase.extend({ type: z.literal("ask"), settings: ask }),
  NodeBase.extend({ type: z.literal("hardstop"), settings: hardstop }),
  NodeBase.extend({ type: z.literal("loop"), settings: loop }),
  NodeBase.extend({ type: z.literal("trigger"), settings: trigger }),
  NodeBase.extend({ type: z.literal("output"), settings: output }),
]);

export const Flow = z.object({
  nodes: z.array(Node),
  wires: z.array(Wire),
  session: Session,
});

export type NodeType = z.infer<typeof NodeType>;
export type WireKind = z.infer<typeof WireKind>;
export type Port = z.infer<typeof Port>;
export type Wire = z.infer<typeof Wire>;
export type Session = z.infer<typeof Session>;
export type Node = z.infer<typeof Node>;
export type Flow = z.infer<typeof Flow>;

export class FlowParseError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super(z.prettifyError(error));
    this.name = "FlowParseError";
    this.issues = error.issues;
  }
}

export function parseFlow(input: unknown): Flow {
  const result = Flow.safeParse(input);
  if (!result.success) throw new FlowParseError(result.error);
  return result.data;
}
