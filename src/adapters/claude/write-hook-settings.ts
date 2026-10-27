import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookSettings } from "../../core/compiler/hook-settings.js";

export async function writeHookSettings(dir: string, settings: HookSettings): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify(settings));
  return path;
}
