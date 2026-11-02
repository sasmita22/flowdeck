import { readFileSync, unlinkSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { z } from "zod";
import { processArgs } from "./process-args.js";

const holderSchema = z.object({ pid: z.number().int(), args: z.string() });

type Holder = z.infer<typeof holderSchema>;

const parseHolder = (text: string): Holder | undefined => {
  try {
    const parsed = holderSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const isCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

export class HomeLock {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async acquire(): Promise<boolean> {
    const holder: Holder = { pid: process.pid, args: (await processArgs(process.pid)) ?? "" };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(this.path, JSON.stringify(holder), { flag: "wx" });
        return true;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      if (await this.heldByAnother()) return false;
      await unlink(this.path).catch((error: unknown) => {
        if (!isCode(error, "ENOENT")) throw error;
      });
    }
    return false;
  }

  release(): void {
    try {
      if (parseHolder(readFileSync(this.path, "utf8"))?.pid === process.pid) unlinkSync(this.path);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }

  private async heldByAnother(): Promise<boolean> {
    const text = await readFile(this.path, "utf8").catch(() => "");
    const holder = parseHolder(text);
    if (holder === undefined || holder.pid === process.pid) return false;
    return (await processArgs(holder.pid)) === holder.args;
  }
}
