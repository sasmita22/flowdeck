import { z } from "zod";

export const settings = z.object({
  condition: z.string(),
  shown: z.string(),
  locked: z.boolean(),
  enabled: z.boolean(),
});
