import { z } from "zod";

export const settings = z.object({
  instructions: z.string(),
  expectedOutput: z.string().optional(),
});
