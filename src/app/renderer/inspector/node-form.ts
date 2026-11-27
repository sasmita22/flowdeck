import type { z } from "zod";
import { agentPlaceholder } from "../../../core/compiler/rules/required-settings.js";
import { agentModelChoices } from "../../../core/flow/choices.js";
import type { Flow, Node, NodeType } from "../../../core/flow/schema.js";
import { decidedByValue, defaultDecidedBy } from "../../../core/nodes/branch/settings.js";
import { registry } from "../../../core/nodes/registry.js";
import {
  assignField,
  describeFields,
  producedChoices,
  withChoices,
  type FieldDescription,
  type FieldValue,
  type Form,
} from "./schema-form.js";

type Path = readonly string[];

const typeForm = (
  labels: Record<string, string>,
  {
    multiline = [],
    hidden = [],
    optionLabels = {},
    choices = {},
    placeholders = {},
    fallbacks = {},
  }: {
    multiline?: string[];
    hidden?: string[];
    optionLabels?: Form["optionLabels"];
    choices?: NonNullable<Form["choices"]>;
    placeholders?: NonNullable<Form["placeholders"]>;
    fallbacks?: NonNullable<Form["fallbacks"]>;
  } = {},
): Form => ({
  prefix: "node-setting",
  labels,
  optionLabels,
  multiline: new Set(multiline),
  hidden: new Set(hidden),
  choices,
  placeholders,
  fallbacks,
});

const forms: Record<NodeType, Form> = {
  agent: typeForm(
    {
      role: "Role",
      instructions: "Instructions",
      model: "Model",
      given: "Files it is given (one per line)",
      writes: "Files it writes (one per line)",
      produces: "Yes/no value it produces (optional)",
    },
    {
      multiline: ["instructions"],
      choices: { model: agentModelChoices },
      placeholders: { instructions: agentPlaceholder },
    },
  ),
  gate: typeForm(
    { stopWhen: "Condition to stop", condition: "Stop when", instruction: "Instruction" },
    {
      multiline: ["condition", "instruction"],
      optionLabels: { stopWhen: { always: "Always", conditional: "Conditional" } },
    },
  ),
  loop: typeForm(
    { condition: "Repeat until", cap: "Round limit", onCap: "At the round limit" },
    {
      multiline: ["condition"],
      optionLabels: { onCap: { ask: "Ask me", fail: "Fail the run" } },
    },
  ),
  trigger: typeForm({}),
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
  branch: typeForm(
    { decidedBy: "Decided by", variable: "Yes/no variable", value: "Value it reads" },
    {
      optionLabels: {
        decidedBy: { variable: "A build variable", value: "A value an earlier Agent produces" },
      },
      fallbacks: { decidedBy: defaultDecidedBy },
    },
  ),
  library: typeForm({}, { hidden: ["libraryId", "label", "overrides"] }),
};

const lockedMessage = "This setting is locked";

type SettingsSchema = z.ZodObject<z.ZodRawShape>;

const schemaOf = (type: NodeType) => registry[type].settings as SettingsSchema;

const branchFields = (
  fields: readonly FieldDescription[],
  flow: Pick<Flow, "nodes"> | undefined,
  settings: Readonly<Record<string, unknown>>,
): FieldDescription[] => {
  const byValue = decidedByValue(settings);
  const shown = fields.filter(({ path }) => path[0] !== (byValue ? "variable" : "value"));
  return byValue ? withChoices(shown, "value", producedChoices(flow?.nodes ?? [])) : shown;
};

const gateFields = (
  fields: FieldDescription[],
  settings: Readonly<Record<string, unknown>>,
): FieldDescription[] =>
  settings["stopWhen"] === "conditional"
    ? fields
    : fields.filter(({ path }) => path[0] !== "condition");

export const describeNodeFields = (
  type: NodeType,
  flow?: Pick<Flow, "nodes">,
  settings: Readonly<Record<string, unknown>> = {},
): FieldDescription[] => {
  const fields = describeFields(schemaOf(type), forms[type]);
  if (type === "branch") return branchFields(fields, flow, settings);
  return type === "gate" ? gateFields(fields, settings) : fields;
};

type SettingResult = { node: Node } | { error: string };

export const applyNodeSetting = (node: Node, path: Path, value: FieldValue): SettingResult => {
  if (forms[node.type].hidden?.has(path.join("."))) return { error: lockedMessage };
  const schema = schemaOf(node.type);
  const parsed = schema.safeParse(assignField(schema, node.settings, path, value));
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  return { node: { ...node, settings: parsed.data } as Node };
};
