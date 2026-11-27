import { z } from "zod";
import type { ManifestContainer, ManifestNode } from "../compiler/lower.js";

export type RunChoices =
  { kind: "choices"; automatic: boolean } | { kind: "error"; message: string };

export const runChoicesSchema: z.ZodType<RunChoices> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choices"), automatic: z.boolean() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

type RunOptions = {
  auto: boolean;
};

type ManifestPart = Pick<ManifestContainer, "nodes">;

const alwaysGate = (node: ManifestNode) =>
  node.type === "gate" && (node.settings as { stopWhen?: unknown }).stopWhen === "always";

export const runChoices = (manifest: ManifestPart): RunChoices => ({
  kind: "choices",
  automatic: manifest.nodes.some(alwaysGate),
});

export const storedOptions = ({ auto }: RunOptions): Record<string, unknown> => ({
  ...(auto ? { auto: true } : {}),
});

export const storedAuto = (stored: Record<string, unknown>): boolean => stored["auto"] === true;
