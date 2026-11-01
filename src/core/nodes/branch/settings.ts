import { z } from "zod";

export const settings = z.object({ flag: z.string().min(1) });
