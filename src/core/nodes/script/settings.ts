import { z } from "zod";

export const settings = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
});
