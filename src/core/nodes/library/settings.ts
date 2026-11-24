import { z } from "zod";

const sessionOverride = z.object({
  repo: z.string().optional(),
  branch: z.string().optional(),
  model: z.string().optional(),
});

export const settings = z.object({
  libraryId: z.string(),
  label: z.string(),
  overrides: z.record(z.string(), sessionOverride).default({}),
});
