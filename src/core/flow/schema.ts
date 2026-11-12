import { z } from "zod";
import { settings as agent } from "../nodes/agent/settings.js";
import { settings as ask } from "../nodes/ask/settings.js";
import { settings as branch } from "../nodes/branch/settings.js";
import { settings as foreach } from "../nodes/foreach/settings.js";
import { settings as fork } from "../nodes/fork/settings.js";
import { settings as gate } from "../nodes/gate/settings.js";
import { settings as hardstop } from "../nodes/hardstop/settings.js";
import { settings as join } from "../nodes/join/settings.js";
import { settings as loop } from "../nodes/loop/settings.js";
import { settings as output } from "../nodes/output/settings.js";
import { settings as trigger } from "../nodes/trigger/settings.js";
import { upgradeFlow } from "./upgrade.js";

export const NodeType = z.enum([
  "agent",
  "gate",
  "ask",
  "hardstop",
  "loop",
  "trigger",
  "output",
  "fork",
  "join",
  "foreach",
  "branch",
]);

export const WireKind = z.enum(["then", "event"]);

export const Port = z.object({
  name: z.string(),
  direction: z.enum(["in", "out"]),
  kind: WireKind,
});

const Endpoint = z.object({ node: z.string(), port: z.string() });
const wireEnds = { from: Endpoint, to: Endpoint };

export const Wire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("then"), ...wireEnds }),
  z.object({ kind: z.literal("event"), ...wireEnds }),
]);

export const Variable = z.discriminatedUnion("kind", [
  z.object({ name: z.string(), kind: z.literal("text"), default: z.string().optional() }),
  z.object({ name: z.string(), kind: z.literal("yesno"), default: z.boolean().optional() }),
]);

export const BuildConfig = z.object({
  repo: z.string().optional(),
  base: z.string().optional(),
  variables: z.array(Variable).default([]),
  buildModel: z.string().optional(),
});

export const Session = z.object({
  name: z.string(),
  buildConfig: BuildConfig,
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
  NodeBase.extend({ type: z.literal("agent"), settings: agent }),
  NodeBase.extend({ type: z.literal("gate"), settings: gate }),
  NodeBase.extend({ type: z.literal("ask"), settings: ask }),
  NodeBase.extend({ type: z.literal("hardstop"), settings: hardstop }),
  NodeBase.extend({ type: z.literal("loop"), settings: loop }),
  NodeBase.extend({ type: z.literal("trigger"), settings: trigger }),
  NodeBase.extend({ type: z.literal("output"), settings: output }),
  NodeBase.extend({ type: z.literal("fork"), settings: fork }),
  NodeBase.extend({ type: z.literal("join"), settings: join }),
  NodeBase.extend({ type: z.literal("foreach"), settings: foreach }),
  NodeBase.extend({ type: z.literal("branch"), settings: branch }),
]);

export const CanvasNote = z.object({
  id: z.string().min(1),
  text: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number().positive(), height: z.number().positive() }),
});

export const Flow = z.object({
  nodes: z.array(Node),
  wires: z.array(Wire),
  session: Session,
  notes: z.array(CanvasNote).optional(),
});

export type NodeType = z.infer<typeof NodeType>;
export type WireKind = z.infer<typeof WireKind>;
export type Port = z.infer<typeof Port>;
export type Wire = z.infer<typeof Wire>;
export type Variable = z.infer<typeof Variable>;
export type BuildConfig = z.infer<typeof BuildConfig>;
export type Session = z.infer<typeof Session>;
export type Node = z.infer<typeof Node>;
export type CanvasNote = z.infer<typeof CanvasNote>;
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
  const result = Flow.safeParse(upgradeFlow(input));
  if (!result.success) throw new FlowParseError(result.error);
  return result.data;
}
