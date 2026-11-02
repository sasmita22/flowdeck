import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = { name: "", type: "" };

export const defaultLabel = "Output";
