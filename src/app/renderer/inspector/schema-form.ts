import { z } from "zod";
import { Session } from "../../../core/flow/schema.js";

type Path = readonly string[];

export type FieldDescription =
  | { control: "text" | "list" | "number"; path: Path; testId: string }
  | {
      control: "select";
      path: Path;
      testId: string;
      options: string[];
      variants: Record<string, FieldDescription[]>;
    };

type AnyObject = z.ZodObject<z.ZodRawShape>;

export const sessionSettingsSchema = Session.pick({
  workingFolder: true,
  model: true,
  allowedTools: true,
  budget: true,
});

const testIdOf = (path: Path) =>
  ["session", ...path]
    .map((part) => part.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
    .join("-");

const unwrap = (schema: z.ZodType): z.ZodType =>
  schema instanceof z.ZodOptional ? unwrap(schema.unwrap() as z.ZodType) : schema;

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

const objectFields = (path: Path, schema: AnyObject, skip?: string): FieldDescription[] =>
  Object.entries(schema.shape)
    .filter(([key]) => key !== skip)
    .flatMap(([key, child]) => fieldsOf([...path, key], child as z.ZodType));

const fieldsOf = (path: Path, schema: z.ZodType): FieldDescription[] => {
  const inner = unwrap(schema);
  const testId = testIdOf(path);
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const discriminator = inner.def.discriminator;
    const variants = Object.fromEntries(
      variantsOf(inner).map((variant) => [
        kindOf(variant, discriminator),
        objectFields(path, variant, discriminator),
      ]),
    );
    const kindPath = [...path, discriminator];
    return [
      {
        control: "select",
        path: kindPath,
        testId: testIdOf(kindPath),
        options: Object.keys(variants),
        variants,
      },
    ];
  }
  if (inner instanceof z.ZodEnum) {
    return [{ control: "select", path, testId, options: inner.options.map(String), variants: {} }];
  }
  if (inner instanceof z.ZodArray && inner.element instanceof z.ZodString) {
    return [{ control: "list", path, testId }];
  }
  if (inner instanceof z.ZodString) return [{ control: "text", path, testId }];
  if (inner instanceof z.ZodNumber) return [{ control: "number", path, testId }];
  if (inner instanceof z.ZodObject) return objectFields(path, inner as AnyObject);
  return [];
};

export const describeFields = (schema: AnyObject): FieldDescription[] => objectFields([], schema);

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

const assign = (schema: z.ZodType, current: unknown, path: Path, value: string): unknown => {
  const inner = unwrap(schema);
  const [key, ...rest] = path;
  if (key === undefined) {
    if (inner instanceof z.ZodNumber) return Number(value);
    return inner instanceof z.ZodArray ? lines(value) : value;
  }
  const record = current as Record<string, unknown>;
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const discriminator = inner.def.discriminator;
    if (key === discriminator) return emptyVariant(variantFor(inner, value), discriminator, value);
    const variant = variantFor(inner, record[discriminator]);
    return { ...record, [key]: assign(childOf(variant, key), record[key], rest, value) };
  }
  if (inner instanceof z.ZodObject) {
    const child = childOf(inner as AnyObject, key);
    if (rest.length === 0 && unwrap(child) instanceof z.ZodNumber) {
      if (value === "") {
        return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
      }
      if (!child.safeParse(Number(value)).success) return record;
    }
    return { ...record, [key]: assign(child, record[key], rest, value) };
  }
  throw new Error(`No field ${key}`);
};

const childOf = (schema: AnyObject, key: string): z.ZodType => {
  const child = schema.shape[key];
  if (child === undefined) throw new Error(`No field ${key}`);
  return child as z.ZodType;
};

export const applyField = (session: Session, path: Path, value: string): Session =>
  assign(Session, session, path, value) as Session;
