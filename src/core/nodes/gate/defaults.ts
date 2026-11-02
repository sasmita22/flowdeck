import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = { shown: "", skippable: false };

export const defaultLabel = "Gate";
