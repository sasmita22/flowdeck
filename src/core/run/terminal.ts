import { z } from "zod";

const dimension = z
  .number()
  .int()
  .transform((n) => Math.max(1, n));

export const terminalSizeSchema = z.object({ cols: dimension, rows: dimension });

export type TerminalSize = z.output<typeof terminalSizeSchema>;

export const terminalStatusSchema = z.object({ available: z.boolean(), attached: z.boolean() });

export type TerminalStatus = z.infer<typeof terminalStatusSchema>;
