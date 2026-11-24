import type { z } from "zod";
import type { settings } from "./settings.js";

export const defaultSettings: z.infer<typeof settings> = {
  libraryId: "",
  label: "library",
  overrides: {},
};

export const defaultLabel = "Library";
