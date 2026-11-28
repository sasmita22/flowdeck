import { z } from "zod";
import type { VariableValues } from "../flow/variables.js";

export type RunVariable = { name: string; value: boolean };

export type RunChoices =
  { kind: "choices"; variables: RunVariable[] } | { kind: "error"; message: string };

export const runChoicesSchema: z.ZodType<RunChoices> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choices"),
    variables: z.array(z.object({ name: z.string(), value: z.boolean() })),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export const runVariables = (values: VariableValues | undefined): RunVariable[] =>
  Object.entries(values ?? {}).flatMap(([name, value]) =>
    typeof value === "boolean" ? [{ name, value }] : [],
  );

type RunOptions = {
  auto: boolean;
  variables?: Record<string, boolean>;
};

export const storedOptions = ({ auto, variables = {} }: RunOptions): Record<string, unknown> => ({
  ...(auto ? { auto: true } : {}),
  ...(Object.keys(variables).length === 0 ? {} : { variables: { ...variables } }),
});

export const storedAuto = (stored: Record<string, unknown>): boolean => stored["auto"] === true;

const storedVariables = (stored: Record<string, unknown>): Record<string, unknown> => {
  const variables = stored["variables"];
  return typeof variables === "object" && variables !== null && !Array.isArray(variables)
    ? (variables as Record<string, unknown>)
    : {};
};

export const runValues = (
  build: VariableValues | undefined,
  stored: Record<string, unknown>,
): VariableValues => {
  const overrides = Object.entries(storedVariables(stored)).flatMap(([name, value]) =>
    typeof value === "boolean" && typeof build?.[name] === "boolean"
      ? [[name, value] as const]
      : [],
  );
  return { ...build, ...Object.fromEntries(overrides) };
};
