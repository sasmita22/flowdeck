import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = {
  condition: "",
  shown: "",
  locked: true,
  enabled: true,
};

export const defaultLabel = "Hard stop";
