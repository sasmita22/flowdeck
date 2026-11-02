import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = { condition: "", cap: 3, onCap: "fail" };

export const defaultLabel = "Loop";
