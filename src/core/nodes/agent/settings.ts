import { z } from "zod";

export const verdictKey = "done";

export const produceRow = z
  .object({
    variable: z
      .string()
      .refine(
        (name) => name !== verdictKey,
        `"${verdictKey}" is the name a Loop's verdict uses; give the value another name`,
      ),
    yesIf: z.string(),
    noIf: z.string(),
  })
  .strict();

export type ProduceRow = z.infer<typeof produceRow>;

const shape = {
  role: z.string(),
  instructions: z.string(),
  model: z.string(),
  produces: z.array(produceRow).optional(),
};

const accepted = new Set<string>([...Object.keys(shape), "tools"]);

export const settings = z
  .looseObject(shape)
  .check((ctx) => {
    const unknown = Object.keys(ctx.value).filter((key) => !accepted.has(key));
    if (unknown.length > 0)
      ctx.issues.push({ code: "unrecognized_keys", keys: unknown, input: ctx.value });
  })
  .overwrite((value) => {
    const kept = { ...value };
    delete kept.tools;
    return kept;
  });
