import { z } from "zod";

export type RunChoices = { kind: "choices" } | { kind: "error"; message: string };

export const runChoicesSchema: z.ZodType<RunChoices> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choices") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

type RunOptions = {
  auto: boolean;
};

export const storedOptions = ({ auto }: RunOptions): Record<string, unknown> => ({
  ...(auto ? { auto: true } : {}),
});

export const storedAuto = (stored: Record<string, unknown>): boolean => stored["auto"] === true;
