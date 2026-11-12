import { z } from "zod";

export const verdictKey = "done";

export const settings = z.object({
  role: z.string(),
  instructions: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  given: z.array(z.string()).optional(),
  writes: z.array(z.string()).optional(),
  produces: z
    .string()
    .refine(
      (name) => name !== verdictKey,
      `"${verdictKey}" is the name a Loop's verdict uses; give the value another name`,
    )
    .optional(),
});

export const producedName = (settings: object): string | undefined =>
  "produces" in settings && typeof settings.produces === "string" && settings.produces !== ""
    ? settings.produces
    : undefined;
