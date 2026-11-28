import type { z } from "zod";
import { agentPlaceholder } from "../../../core/compiler/rules/required-settings.js";
import { agentModelChoices } from "../../../core/flow/choices.js";
import { unknownLibraries, type LibraryLookup } from "../../../core/flow/libraries.js";
import type { Flow, Node, NodeType } from "../../../core/flow/schema.js";
import { blueprintVariables } from "../../../core/flow/variables.js";
import { registry } from "../../../core/nodes/registry.js";
import {
  asChoices,
  assignField,
  describeFields,
  withChoices,
  withComboOptions,
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
    combos = {},
    addLabels = {},
  }: {
    multiline?: string[];
    hidden?: string[];
    optionLabels?: Form["optionLabels"];
    choices?: NonNullable<Form["choices"]>;
    placeholders?: NonNullable<Form["placeholders"]>;
    fallbacks?: NonNullable<Form["fallbacks"]>;
    combos?: NonNullable<Form["combos"]>;
    addLabels?: NonNullable<Form["addLabels"]>;
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
  combos,
  addLabels,
});

const forms: Record<NodeType, Form> = {
  agent: typeForm(
    {
      role: "Role",
      instructions: "Instructions",
      model: "Model",
      produces: "Variables it produces",
      "produces.variable": "Variable name",
      "produces.yesIf": "Yes if",
      "produces.noIf": "No if",
    },
    {
      multiline: ["instructions"],
      choices: { model: agentModelChoices },
      placeholders: { instructions: agentPlaceholder },
      addLabels: { produces: "+ Produce variable" },
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
    { variable: "Variable name" },
    { hidden: ["shared"], combos: { variable: "shared" } },
  ),
  library: typeForm({}, { hidden: ["libraryId", "label", "overrides"] }),
};

const lockedMessage = "This setting is locked";

type SettingsSchema = z.ZodObject<z.ZodRawShape>;

const schemaOf = (type: NodeType) => registry[type].settings as SettingsSchema;

export type FieldScope = { nodeId?: string; libraries?: LibraryLookup };

const otherBranchVariables = (flow: Flow | undefined, nodeId: string | undefined): string[] => [
  ...new Set(
    (flow?.nodes ?? []).flatMap((node) =>
      node.type === "branch" && node.id !== nodeId && node.settings.variable !== ""
        ? [node.settings.variable]
        : [],
    ),
  ),
];

const ownedVariables = (flow: Flow | undefined, libraries: LibraryLookup): string[] =>
  flow === undefined ? [] : blueprintVariables(flow, libraries).owned.map(({ name }) => name);

const gateFields = (
  fields: FieldDescription[],
  settings: Readonly<Record<string, unknown>>,
): FieldDescription[] =>
  settings["stopWhen"] === "conditional"
    ? fields
    : fields.filter(({ path }) => path[0] !== "condition");

export const describeNodeFields = (
  type: NodeType,
  flow?: Flow,
  settings: Readonly<Record<string, unknown>> = {},
  { nodeId, libraries = unknownLibraries }: FieldScope = {},
): FieldDescription[] => {
  const fields = describeFields(schemaOf(type), forms[type], settings);
  if (type === "branch") {
    return withComboOptions(fields, "variable", otherBranchVariables(flow, nodeId));
  }
  if (type === "agent") {
    return withChoices(fields, "produces.variable", asChoices(ownedVariables(flow, libraries)));
  }
  return type === "gate" ? gateFields(fields, settings) : fields;
};

type SettingResult = { node: Node } | { error: string };

const withCombo = (
  form: Form,
  settings: Readonly<Record<string, unknown>>,
  path: Path,
  value: FieldValue,
): Record<string, unknown> | undefined => {
  const [key] = path;
  const flag = form.combos?.[path.join(".")];
  if (key === undefined || flag === undefined) return undefined;
  const rest = Object.fromEntries(Object.entries(settings).filter(([name]) => name !== flag));
  if (typeof value === "object" && "pick" in value) {
    return { ...rest, [key]: value.pick, [flag]: true };
  }
  return { ...rest, [key]: value };
};

export const applyNodeSetting = (node: Node, path: Path, value: FieldValue): SettingResult => {
  const form = forms[node.type];
  if (form.hidden?.has(path.join("."))) return { error: lockedMessage };
  const schema = schemaOf(node.type);
  const next =
    withCombo(form, node.settings, path, value) ?? assignField(schema, node.settings, path, value);
  const parsed = schema.safeParse(next);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  return { node: { ...node, settings: parsed.data } as Node };
};
