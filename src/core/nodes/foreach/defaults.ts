import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = { file: "items.txt" };

export const defaultLabel = "For each";
