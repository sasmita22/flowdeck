import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = {
  role: "",
  instructions: "",
  model: "sonnet",
  tools: [],
};

export const defaultLabel = "Agent";
