import { z } from "zod";

export const settings = z.object({
  role: z.string(),
  instructions: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  given: z.array(z.string()).optional(),
  writes: z.array(z.string()).optional(),
});
