import { z } from "zod";

export const settings = z.object({
  stopWhen: z.enum(["always", "conditional"]),
  condition: z.string(),
  instruction: z.string(),
});
