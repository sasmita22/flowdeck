import type { BuildConfig } from "./schema.js";

export type VariableValues = Readonly<Record<string, string | boolean>>;

export const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const reference = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const isVariableName = (name: string): boolean => safeName.test(name);

export const referencedVariables = (text: string): string[] => [
  ...new Set(Array.from(text.matchAll(reference), ([, name]) => name ?? "")),
];

export const fillVariables = (text: string, values: VariableValues): string =>
  text.replace(reference, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });

export const unsetVariables = (buildConfig: BuildConfig, values: VariableValues): string[] =>
  buildConfig.variables
    .filter((variable) => {
      const value = values[variable.name] ?? variable.default;
      return value === undefined || value === "";
    })
    .map((variable) => variable.name);
