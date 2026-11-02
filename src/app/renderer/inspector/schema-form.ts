import { z } from "zod";
import { Session } from "../../../core/flow/schema.js";

type Path = readonly string[];

export type FieldValue = string | boolean | Readonly<Record<string, string | number | boolean>>;

export type FieldDescription =
  | {
      control: "text" | "multiline" | "list" | "number" | "toggle" | "flags";
      path: Path;
      testId: string;
      label: string;
    }
  | {
      control: "select";
      path: Path;
      testId: string;
      label: string;
      options: string[];
      optionLabels: Record<string, string>;
      variants: Record<string, FieldDescription[]>;
    };

type AnyObject = z.ZodObject<z.ZodRawShape>;

export const sessionSettingsSchema = Session.pick({
  workingFolder: true,
  model: true,
  allowedTools: true,
  budget: true,
});

export type Form = {
  prefix: string;
  labels: Readonly<Record<string, string>>;
  optionLabels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  multiline?: ReadonlySet<string>;
  hidden?: ReadonlySet<string>;
};

const sessionLabels: Record<string, string> = {
  "workingFolder.kind": "Working folder",
  "workingFolder.path": "Folder path",
  "workingFolder.repo": "Repository",
  "workingFolder.branch": "Start from branch",
  model: "Model",
  allowedTools: "Allowed tools (one per line)",
  budget: "Budget ($)",
};

const sessionForm: Form = {
  prefix: "session",
  labels: sessionLabels,
  optionLabels: {
    "workingFolder.kind": { path: "Existing folder", worktree: "New git worktree" },
  },
};

const labelOf = (form: Form, path: Path): string => {
  const label = form.labels[path.join(".")];
  if (label === undefined) throw new Error(`No label for ${path.join(".")}`);
  return label;
};

const optionLabelsOf = (form: Form, path: Path, options: string[]): Record<string, string> =>
  Object.fromEntries(
    options.map((option) => [option, form.optionLabels[path.join(".")]?.[option] ?? option]),
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

const objectFields = (
  form: Form,
  path: Path,
  schema: AnyObject,
  skip?: string,
): FieldDescription[] =>
  Object.entries(schema.shape)
    .filter(([key]) => key !== skip && !form.hidden?.has([...path, key].join(".")))
    .flatMap(([key, child]) => fieldsOf(form, [...path, key], child as z.ZodType));

const fieldsOf = (form: Form, path: Path, schema: z.ZodType): FieldDescription[] => {
  const inner = unwrap(schema);
  const testId = testIdOf(form, path);
  const label = () => labelOf(form, path);
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const discriminator = inner.def.discriminator;
    const variants = Object.fromEntries(
      variantsOf(inner).map((variant) => [
        kindOf(variant, discriminator),
        objectFields(form, path, variant, discriminator),
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
    return [
      {
        control: "select",
        path,
        testId,
        label: label(),
        options,
        optionLabels: optionLabelsOf(form, path, options),
        variants: {},
      },
    ];
  }
  if (
    inner instanceof z.ZodArray &&
    (inner.element instanceof z.ZodString || inner.element instanceof z.ZodNumber)
  ) {
    return [{ control: "list", path, testId, label: label() }];
  }
  if (inner instanceof z.ZodString) {
    const control = form.multiline?.has(path.join(".")) ? "multiline" : "text";
    return [{ control, path, testId, label: label() }];
  }
  if (inner instanceof z.ZodNumber) return [{ control: "number", path, testId, label: label() }];
  if (inner instanceof z.ZodBoolean) return [{ control: "toggle", path, testId, label: label() }];
  if (inner instanceof z.ZodRecord) return [{ control: "flags", path, testId, label: label() }];
  if (inner instanceof z.ZodObject) return objectFields(form, path, inner as AnyObject);
  return [];
};

export const describeFields = (schema: AnyObject, form: Form = sessionForm): FieldDescription[] =>
  objectFields(form, [], schema);

const emptyVariant = (variant: AnyObject, discriminator: string, kind: string) =>
  Object.fromEntries(
    Object.entries(variant.shape).flatMap(([key, child]): [string, unknown][] => {
      if (key === discriminator) return [[key, kind]];
      if (child instanceof z.ZodOptional) return [];
      return [[key, child instanceof z.ZodArray ? [] : ""]];
    }),
  );

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
    if (typeof value !== "string") return value;
    if (inner instanceof z.ZodNumber) return Number(value);
    if (!(inner instanceof z.ZodArray)) return value;
    return inner.element instanceof z.ZodNumber ? lines(value).map(Number) : lines(value);
  }
  const record = current as Record<string, unknown>;
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const discriminator = inner.def.discriminator;
    if (key === discriminator && typeof value === "string") {
      return emptyVariant(variantFor(inner, value), discriminator, value);
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

export const applyField = (session: Session, path: Path, value: string): Session =>
  assignField(Session, session, path, value) as Session;
