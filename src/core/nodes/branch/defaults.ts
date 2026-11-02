import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = { flag: "flag" };

export const defaultLabel = "Branch";
