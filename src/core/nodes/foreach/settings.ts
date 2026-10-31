import { z } from "zod";

export const settings = z.object({
  file: z
    .string()
    .min(1)
    .refine((file) => !file.startsWith("/"), "must be relative to the session folder")
    .refine((file) => !file.split("/").includes(".."), "must not contain .."),
});
