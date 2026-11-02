import type { z } from "zod";
import type { Node, NodeType } from "../../../core/flow/schema.js";
import { registry } from "../../../core/nodes/registry.js";
import {
  assignField,
  describeFields,
  type FieldDescription,
  type FieldValue,
  type Form,
} from "./schema-form.js";

type Path = readonly string[];

type Flags = Readonly<Record<string, string | number | boolean>>;

const typeForm = (
  labels: Record<string, string>,
  {
    multiline = [],
    hidden = [],
    optionLabels = {},
  }: {
    multiline?: string[];
    hidden?: string[];
    optionLabels?: Form["optionLabels"];
  } = {},
): Form => ({
  prefix: "node-setting",
  labels,
  optionLabels,
  multiline: new Set(multiline),
  hidden: new Set(hidden),
});

const forms: Record<NodeType, Form> = {
  prompt: typeForm(
    { instructions: "Instructions", expectedOutput: "What it should produce" },
    { multiline: ["instructions", "expectedOutput"] },
  ),
  script: typeForm({ command: "Command", args: "Arguments (one per line)" }),
  agent: typeForm(
    {
      role: "Role",
      instructions: "Instructions",
      model: "Model",
      tools: "Allowed tools (one per line)",
      given: "Files it is given (one per line)",
      writes: "Files it writes (one per line)",
    },
    { multiline: ["instructions"] },
  ),
  gate: typeForm(
    { shown: "What to show you", skippable: "Skip it in automatic runs" },
    { multiline: ["shown"] },
  ),
  ask: typeForm(
    { question: "Question", options: "Answers to pick from (one per line)" },
    { multiline: ["question"] },
  ),
  hardstop: typeForm(
    { condition: "Stop when", shown: "What to show you" },
    { multiline: ["condition", "shown"], hidden: ["locked", "enabled"] },
  ),
  loop: typeForm(
    { condition: "Repeat until", cap: "Round limit", onCap: "At the round limit" },
    {
      multiline: ["condition"],
      optionLabels: { onCap: { ask: "Ask me", fail: "Fail the run" } },
    },
  ),
  trigger: typeForm({
    inputs: "Inputs (one per line)",
    flags: "Flags (ticked means on by default)",
  }),
  output: typeForm({ name: "Output name", type: "Output type" }),
  fork: typeForm({}),
  join: typeForm(
    { wait: "Continue when" },
    {
      optionLabels: {
        wait: { all: "Every branch is done", first: "The first branch is done" },
      },
    },
  ),
  foreach: typeForm({ file: "List file, one item per line" }),
  branch: typeForm({ flag: "Flag on the Trigger" }),
};

const lockedMessage = "Hard stop is locked";

type SettingsSchema = z.ZodObject<z.ZodRawShape>;

const schemaOf = (type: NodeType) => registry[type].settings as SettingsSchema;

export const describeNodeFields = (type: NodeType): FieldDescription[] =>
  describeFields(schemaOf(type), forms[type]);

export type SettingResult = { node: Node } | { error: string };

export const applyNodeSetting = (node: Node, path: Path, value: FieldValue): SettingResult => {
  if (forms[node.type].hidden?.has(path.join("."))) return { error: lockedMessage };
  const schema = schemaOf(node.type);
  const parsed = schema.safeParse(assignField(schema, node.settings, path, value));
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  return { node: { ...node, settings: parsed.data } as Node };
};

const freeName = (flags: Flags) => {
  let name = "flag";
  for (let n = 2; name in flags; n += 1) name = `flag-${n}`;
  return name;
};

export const addFlag = (flags: Flags): Flags => ({ ...flags, [freeName(flags)]: false });

export const setFlag = (flags: Flags, name: string, on: boolean): Flags => ({
  ...flags,
  [name]: on,
});

export const renameFlag = (flags: Flags, from: string, to: string): Flags => {
  const name = to.trim();
  if (name === "" || (name !== from && name in flags)) return flags;
  return Object.fromEntries(
    Object.entries(flags).map(([key, value]) => [key === from ? name : key, value]),
  );
};

export const removeFlag = (flags: Flags, name: string): Flags =>
  Object.fromEntries(Object.entries(flags).filter(([key]) => key !== name));
