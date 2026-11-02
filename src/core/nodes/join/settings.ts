import { z } from "zod";

export const settings = z.object({
  wait: z.enum(["all", "first"], "Choose when to continue").default("all"),
});
