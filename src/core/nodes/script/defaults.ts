import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = { command: "" };

export const defaultLabel = "Script";
