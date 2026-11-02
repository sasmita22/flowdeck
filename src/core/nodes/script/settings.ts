import { z } from "zod";

const exitCodes = z
  .array(z.number("Exit codes are whole numbers").int("Exit codes are whole numbers"))
  .optional();

export const settings = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  successCodes: exitCodes,
  retryCodes: exitCodes,
});
