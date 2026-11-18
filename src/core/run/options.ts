import { z } from "zod";
import type { Manifest } from "../compiler/lower.js";

export type RunChoices = { automatic: boolean };

export const runChoicesSchema = z.object({ automatic: z.boolean() });

export type RunOptions = {
  inputs: Record<string, string>;
  flags: Record<string, boolean>;
  auto: boolean;
};

type ManifestPart = Pick<Manifest, "nodes">;

const skippable = (node: Manifest["nodes"][number]) =>
  node.type === "gate" && (node.settings as { skippable?: unknown }).skippable === true;

export const runChoices = (manifest: ManifestPart): RunChoices => ({
  automatic: manifest.nodes.some(skippable),
});

export const storedOptions = ({ inputs, flags, auto }: RunOptions): Record<string, unknown> => ({
  ...inputs,
  ...flags,
  ...(auto ? { auto: true } : {}),
});

export const storedAuto = (stored: Record<string, unknown>): boolean => stored["auto"] === true;
