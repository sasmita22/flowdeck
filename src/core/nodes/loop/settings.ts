import { z } from "zod";

export const settings = z.object({
  condition: z.string(),
  cap: z.number().default(3),
  onCap: z.enum(["ask", "fail"]).optional(),
});
