import { z } from "zod";

export const settings = z.object({
  name: z.string(),
  type: z.string(),
});
