import type { z } from "zod";
import { agentPlaceholder } from "../../../core/compiler/rules/required-settings.js";
import { agentModelChoices } from "../../../core/flow/choices.js";
import type { Flow, Node, NodeType } from "../../../core/flow/schema.js";
import { triggerFlags } from "../../../core/nodes/branch/execute.js";
import { registry } from "../../../core/nodes/registry.js";
import {
  assignField,
  describeFields,
  withChoices,
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
    choices = {},
    placeholders = {},
  }: {
    multiline?: string[];
    hidden?: string[];
    optionLabels?: Form["optionLabels"];
    choices?: NonNullable<Form["choices"]>;
    placeholders?: NonNullable<Form["placeholders"]>;
  } = {},
): Form => ({
  prefix: "node-setting",
  labels,
  optionLabels,
  multiline: new Set(multiline),
  hidden: new Set(hidden),
  choices,
  placeholders,
});

const forms: Record<NodeType, Form> = {
  prompt: typeForm(
    { instructions: "Instructions", expectedOutput: "What it should produce" },
    { multiline: ["instructions", "expectedOutput"] },
  ),
  script: typeForm({
    command: "Command",
    args: "Arguments (one per line)",
    successCodes: "Exit codes that mean done (one per line, 0 when empty)",
    retryCodes: "Exit codes that run it once more (one per line, 2 when empty)",
  }),
  agent: typeForm(
    {
      role: "Role",
      instructions: "Instructions",
      model: "Model",
      tools: "Allowed tools (one per line)",
      given: "Files it is given (one per line)",
      writes: "Files it writes (one per line)",
    },
    {
      multiline: ["instructions"],
      choices: { model: agentModelChoices },
      placeholders: { instructions: agentPlaceholder },
    },
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
    { wait: "Continue when", onBranchFail: "If a branch does not start" },
    {
      optionLabels: {
        wait: { all: "Every branch is done", first: "The first branch is done" },
        onBranchFail: {
          wait: "Wait for me to decide",
          skip: "Go on without it",
          stop: "Stop the run",
        },
      },
    },
  ),
  foreach: typeForm({ file: "List file, one item per line" }),
  branch: typeForm({ flag: "Flag on the Trigger" }),
};

const lockedMessage = "Hard stop is locked";

type SettingsSchema = z.ZodObject<z.ZodRawShape>;

const schemaOf = (type: NodeType) => registry[type].settings as SettingsSchema;

const flagChoices = (flow: Pick<Flow, "nodes"> | undefined) =>
  Object.entries(triggerFlags(flow?.nodes ?? [])).map(([name, on]) => ({
    value: name,
    label: `${name} (${on ? "on" : "off"} by default)`,
  }));

export const describeNodeFields = (
  type: NodeType,
  flow?: Pick<Flow, "nodes">,
): FieldDescription[] => {
  const fields = describeFields(schemaOf(type), forms[type]);
  return type === "branch" ? withChoices(fields, "flag", flagChoices(flow)) : fields;
};

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
