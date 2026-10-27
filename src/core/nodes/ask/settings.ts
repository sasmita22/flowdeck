import { z } from "zod";

export const settings = z.object({
  question: z.string(),
  options: z.array(z.string()),
});
