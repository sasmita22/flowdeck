import { z } from "zod";
import type { Manifest } from "../compiler/lower.js";
import { triggerFlags } from "../nodes/branch/execute.js";

export type RunChoices = { automatic: boolean };

export const runChoicesSchema = z.object({ automatic: z.boolean() });

export type RunOptions = {
  inputs: Record<string, string>;
  flags: Record<string, boolean>;
  auto: boolean;
};

type ManifestPart = Pick<Manifest, "nodes"> & Partial<Pick<Manifest, "inputs">>;

const skippable = (node: Manifest["nodes"][number]) =>
  node.type === "gate" && (node.settings as { skippable?: unknown }).skippable === true;

export const runChoices = (manifest: ManifestPart): RunChoices => ({
  automatic: manifest.nodes.some(skippable),
});

export const optionsClash = (manifest: ManifestPart): string | undefined => {
  const flags = Object.keys(triggerFlags(manifest.nodes));
  const inputs = manifest.inputs ?? [];
  for (const builtIn of ["auto", "model"]) {
    if (flags.includes(builtIn))
      return `Blueprint variable "${builtIn}" clashes with the built-in option --${builtIn}`;
    if (inputs.includes(builtIn))
      return `Blueprint variable "${builtIn}" clashes with the built-in option --${builtIn}`;
  }
  const shared = inputs.find((name) => flags.includes(name));
  return shared === undefined
    ? undefined
    : `Blueprint variable "${shared}" is declared twice, once as text and once as yes/no`;
};

export const storedOptions = ({ inputs, flags, auto }: RunOptions): Record<string, unknown> => ({
  ...inputs,
  ...flags,
  ...(auto ? { auto: true } : {}),
});

export const storedFlags = (
  stored: Record<string, unknown>,
  manifest: ManifestPart,
): Record<string, boolean> =>
  Object.fromEntries(
    Object.keys(triggerFlags(manifest.nodes)).flatMap((name) => {
      const value = stored[name];
      return typeof value === "boolean" ? [[name, value]] : [];
    }),
  );

export const storedAuto = (stored: Record<string, unknown>): boolean => stored["auto"] === true;
