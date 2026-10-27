import { z } from "zod";

export const settings = z.object({
  shown: z.string(),
  skippable: z.boolean(),
});
