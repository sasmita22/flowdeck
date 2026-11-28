import { z } from "zod";
import { modelChoices, permissionModes, type Choice } from "../../../core/flow/choices.js";
import {
  FlowSettings,
  SessionContainer,
  WorkspaceContainer,
  type FlowContainer,
} from "../../../core/flow/schema.js";

type Path = readonly string[];

export type FieldValue =
  string | boolean | { readonly pick: string } | { readonly row: "add" | "remove" };

export type FieldRow = { removeTestId: string; fields: FieldDescription[] };

export type FieldDescription =
  | {
      control: "text" | "multiline" | "list" | "number" | "toggle";
      path: Path;
      testId: string;
      label: string;
      placeholder?: string;
    }
  | {
      control: "combo";
      path: Path;
      testId: string;
      existingTestId: string;
      label: string;
      options: string[];
    }
  | {
      control: "rows";
      path: Path;
      testId: string;
      label: string;
      addLabel: string;
      addTestId: string;
      rows: FieldRow[];
    }
  | {
      control: "select";
      path: Path;
      testId: string;
      label: string;
      options: string[];
      optionLabels: Record<string, string>;
      variants: Record<string, FieldDescription[]>;
      fallback?: string;
    };

type AnyObject = z.ZodObject<z.ZodRawShape>;

export type Form = {
  prefix: string;
  labels: Readonly<Record<string, string>>;
  optionLabels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  multiline?: ReadonlySet<string>;
  hidden?: ReadonlySet<string>;
  choices?: Readonly<Record<string, readonly Choice[]>>;
  placeholders?: Readonly<Record<string, string>>;
  fallbacks?: Readonly<Record<string, string>>;
  combos?: Readonly<Record<string, string>>;
  addLabels?: Readonly<Record<string, string>>;
};

const containerForm = (container: FlowContainer): Form => ({
  prefix: `container-${container.id}`,
  labels: {
    name: "Session name",
    repo: "Repository",
    branch: "Start from branch",
    model: "Model",
  },
  optionLabels: {},
  choices: { model: modelChoices },
});

const containerSettings = {
  workspace: WorkspaceContainer.pick({ model: true }),
  session: SessionContainer.pick({ name: true, repo: true, branch: true, model: true }),
};

const settingsForm: Form = {
  prefix: "settings",
  labels: { buildModel: "Build model", permissionMode: "Permission mode" },
  optionLabels: {},
  choices: { buildModel: modelChoices, permissionMode: permissionModes },
};

const keyOf = (path: Path): string => path.filter((part) => !/^\d+$/.test(part)).join(".");

const labelOf = (form: Form, path: Path): string => {
  const label = form.labels[keyOf(path)];
  if (label === undefined) throw new Error(`No label for ${keyOf(path)}`);
  return label;
};

const addLabelOf = (form: Form, path: Path): string => {
  const label = form.addLabels?.[keyOf(path)];
  if (label === undefined) throw new Error(`No add label for ${keyOf(path)}`);
  return label;
};

const optionLabelsOf = (form: Form, path: Path, options: string[]): Record<string, string> =>
  Object.fromEntries(
    options.map((option) => [option, form.optionLabels[keyOf(path)]?.[option] ?? option]),
  );

const testIdOf = (form: Form, path: Path) =>
  [form.prefix, ...path]
    .map((part) => part.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
    .join("-");

const unwrap = (schema: z.ZodType): z.ZodType =>
  schema instanceof z.ZodOptional || schema instanceof z.ZodDefault
    ? unwrap(schema.unwrap() as z.ZodType)
    : schema;

const variantsOf = (union: z.ZodDiscriminatedUnion): AnyObject[] =>
  union.options.filter((option): option is AnyObject => option instanceof z.ZodObject);

const kindOf = (variant: AnyObject, discriminator: string): string => {
  const literal = variant.shape[discriminator];
  return literal instanceof z.ZodLiteral ? String(literal.value) : "";
};

const variantFor = (union: z.ZodDiscriminatedUnion, kind: unknown): AnyObject => {
  const variant = variantsOf(union).find(
    (option) => kindOf(option, union.def.discriminator) === kind,
  );
  if (variant === undefined) throw new Error(`Unknown ${union.def.discriminator}: ${String(kind)}`);
  return variant;
};

const valueAt = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], root);

const objectFields = (
  form: Form,
  path: Path,
  schema: AnyObject,
  values: unknown,
  skip?: string,
): FieldDescription[] =>
  Object.entries(schema.shape)
    .filter(([key]) => key !== skip && !form.hidden?.has(keyOf([...path, key])))
    .flatMap(([key, child]) => fieldsOf(form, [...path, key], child as z.ZodType, values));

const rowsField = (
  form: Form,
  path: Path,
  element: AnyObject,
  values: unknown,
): FieldDescription => {
  const stored = valueAt(values, path);
  const testId = testIdOf(form, path);
  return {
    control: "rows",
    path,
    testId,
    label: labelOf(form, path),
    addLabel: addLabelOf(form, path),
    addTestId: `${testId}-add`,
    rows: (Array.isArray(stored) ? stored : []).map((_, index) => {
      const rowPath = [...path, String(index)];
      return {
        removeTestId: `${testIdOf(form, rowPath)}-remove`,
        fields: objectFields(form, rowPath, element, values),
      };
    }),
  };
};

const fieldsOf = (
  form: Form,
  path: Path,
  schema: z.ZodType,
  values: unknown,
): FieldDescription[] => {
  const inner = unwrap(schema);
  const testId = testIdOf(form, path);
  const label = () => labelOf(form, path);
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const discriminator = inner.def.discriminator;
    const variants = Object.fromEntries(
      variantsOf(inner).map((variant) => [
        kindOf(variant, discriminator),
        objectFields(form, path, variant, values, discriminator),
      ]),
    );
    const kindPath = [...path, discriminator];
    const options = Object.keys(variants);
    return [
      {
        control: "select",
        path: kindPath,
        testId: testIdOf(form, kindPath),
        label: labelOf(form, kindPath),
        options,
        optionLabels: optionLabelsOf(form, kindPath, options),
        variants,
      },
    ];
  }
  if (inner instanceof z.ZodEnum) {
    const options = inner.options.map(String);
    const fallback = form.fallbacks?.[keyOf(path)];
    return [
      {
        control: "select",
        path,
        testId,
        label: label(),
        options,
        optionLabels: optionLabelsOf(form, path, options),
        variants: {},
        ...(fallback === undefined ? {} : { fallback }),
      },
    ];
  }
  if (
    inner instanceof z.ZodArray &&
    (inner.element instanceof z.ZodString || inner.element instanceof z.ZodNumber)
  ) {
    return [{ control: "list", path, testId, label: label() }];
  }
  if (inner instanceof z.ZodArray && inner.element instanceof z.ZodObject) {
    return [rowsField(form, path, inner.element as AnyObject, values)];
  }
  if (inner instanceof z.ZodString) {
    const key = keyOf(path);
    if (form.combos?.[key] !== undefined) {
      return [
        {
          control: "combo",
          path,
          testId,
          existingTestId: `${testId}-existing`,
          label: label(),
          options: [],
        },
      ];
    }
    const choices = form.choices?.[key];
    if (choices !== undefined)
      return [picked({ control: "text", path, testId, label: label() }, choices)];
    const control = form.multiline?.has(key) ? "multiline" : "text";
    const placeholder = form.placeholders?.[key];
    return [
      {
        control,
        path,
        testId,
        label: label(),
        ...(placeholder === undefined ? {} : { placeholder }),
      },
    ];
  }
  if (inner instanceof z.ZodNumber) return [{ control: "number", path, testId, label: label() }];
  if (inner instanceof z.ZodBoolean) return [{ control: "toggle", path, testId, label: label() }];
  if (inner instanceof z.ZodObject) return objectFields(form, path, inner as AnyObject, values);
  return [];
};

export const describeFields = (
  schema: AnyObject,
  form: Form,
  values: unknown = {},
): FieldDescription[] => objectFields(form, [], schema, values);

const picked = (field: FieldDescription, choices: readonly Choice[]): FieldDescription => ({
  control: "select",
  path: field.path,
  testId: field.testId,
  label: field.label,
  options: choices.map(({ value }) => value),
  optionLabels: Object.fromEntries(choices.map(({ value, label }) => [value, label])),
  variants: {},
});

export const withChoices = (
  fields: readonly FieldDescription[],
  path: string,
  choices: readonly Choice[],
): FieldDescription[] =>
  fields.map((field) => {
    if (keyOf(field.path) === path) return picked(field, choices);
    if (field.control === "rows") {
      return {
        ...field,
        rows: field.rows.map((row) => ({ ...row, fields: withChoices(row.fields, path, choices) })),
      };
    }
    if (field.control !== "select") return field;
    return {
      ...field,
      variants: Object.fromEntries(
        Object.entries(field.variants).map(([kind, inner]) => [
          kind,
          withChoices(inner, path, choices),
        ]),
      ),
    };
  });

export const asChoices = (values: readonly string[]): Choice[] =>
  values.map((value) => ({ value, label: value }));

export const withComboOptions = (
  fields: readonly FieldDescription[],
  path: string,
  options: readonly string[],
): FieldDescription[] =>
  fields.map((field) =>
    field.control === "combo" && keyOf(field.path) === path
      ? { ...field, options: [...options] }
      : field,
  );

export const containerFields = (container: FlowContainer): FieldDescription[] =>
  describeFields(containerSettings[container.kind], containerForm(container));

type SharedField = "model" | "repo" | "branch";

const sharedFields: Readonly<Record<string, SharedField>> = {
  model: "model",
  buildModel: "model",
  repo: "repo",
  branch: "branch",
};

export const sharedFieldFor = (path: Path): SharedField | undefined => sharedFields[path.join(".")];

export const settingsFields = (): FieldDescription[] => describeFields(FlowSettings, settingsForm);

const emptyObject = (schema: AnyObject, fixed: Readonly<Record<string, string>> = {}) =>
  Object.fromEntries(
    Object.entries(schema.shape).flatMap(([key, child]): [string, unknown][] => {
      const value = fixed[key];
      if (value !== undefined) return [[key, value]];
      if (child instanceof z.ZodOptional) return [];
      return [[key, child instanceof z.ZodArray ? [] : ""]];
    }),
  );

const isRowEdit = (value: FieldValue, row: "add" | "remove"): boolean =>
  typeof value === "object" && "row" in value && value.row === row;

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export const assignField = (
  schema: z.ZodType,
  current: unknown,
  path: Path,
  value: FieldValue,
): unknown => {
  const inner = unwrap(schema);
  const [key, ...rest] = path;
  if (key === undefined) {
    if (
      inner instanceof z.ZodArray &&
      inner.element instanceof z.ZodObject &&
      isRowEdit(value, "add")
    ) {
      return [...(Array.isArray(current) ? current : []), emptyObject(inner.element as AnyObject)];
    }
    if (typeof value === "object") throw new Error("No field takes this edit");
    if (typeof value !== "string") return value;
    if (inner instanceof z.ZodNumber) return Number(value);
    if (!(inner instanceof z.ZodArray)) return value;
    return inner.element instanceof z.ZodNumber ? lines(value).map(Number) : lines(value);
  }
  if (inner instanceof z.ZodArray && /^\d+$/.test(key)) {
    const index = Number(key);
    const list: unknown[] = Array.isArray(current) ? current : [];
    if (rest.length === 0 && isRowEdit(value, "remove")) {
      return list.filter((_, at) => at !== index);
    }
    return list.map((item, at) =>
      at === index ? assignField(inner.element as z.ZodType, item, rest, value) : item,
    );
  }
  const record = current as Record<string, unknown>;
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const discriminator = inner.def.discriminator;
    if (key === discriminator && typeof value === "string") {
      return emptyObject(variantFor(inner, value), { [discriminator]: value });
    }
    const variant = variantFor(inner, record[discriminator]);
    return { ...record, [key]: assignField(childOf(variant, key), record[key], rest, value) };
  }
  if (inner instanceof z.ZodObject) {
    const child = childOf(inner as AnyObject, key);
    if (rest.length === 0 && unwrap(child) instanceof z.ZodNumber && typeof value === "string") {
      if (value === "") {
        return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
      }
      if (!child.safeParse(Number(value)).success) return record;
    }
    return { ...record, [key]: assignField(child, record[key], rest, value) };
  }
  throw new Error(`No field ${key}`);
};

const childOf = (schema: AnyObject, key: string): z.ZodType => {
  const child = schema.shape[key];
  if (child === undefined) throw new Error(`No field ${key}`);
  return child as z.ZodType;
};
