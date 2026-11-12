import { z } from "zod";

export const settings = z.object({
  decidedBy: z.enum(["variable", "value"]).optional(),
  variable: z.string(),
  value: z.string().optional(),
});

export type BranchSettings = z.infer<typeof settings>;

export const defaultDecidedBy = "variable";

export const decidedByValue = (branch: Pick<BranchSettings, "decidedBy">): boolean =>
  (branch.decidedBy ?? defaultDecidedBy) === "value";
