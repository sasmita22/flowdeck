import { z } from "zod";

export const settings = z
  .object({
    variable: z.string(),
    shared: z.boolean().optional(),
  })
  .strict();

export type BranchSettings = z.infer<typeof settings>;
