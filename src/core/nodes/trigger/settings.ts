import { z } from "zod";

export const settings = z.object({
  inputs: z.array(z.string()),
  flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
