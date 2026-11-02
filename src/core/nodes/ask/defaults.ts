import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = { question: "", options: [] };

export const defaultLabel = "Ask";
