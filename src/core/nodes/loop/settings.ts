import { z } from "zod";

export const settings = z.object({
  condition: z.string(),
  cap: z.number().optional(),
  onCap: z.enum(["ask", "fail"]).optional(),
});
