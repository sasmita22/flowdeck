import type { z } from "zod";
import type { settings } from "./settings.js";

export type JoinWait = z.infer<typeof settings>["wait"];

export function joinComplete(
  wait: JoinWait,
  branchTypes: readonly string[],
  stoppedTypes: ReadonlySet<string>,
): boolean {
  const stopped = (type: string) => stoppedTypes.has(type);
  return wait === "all" ? branchTypes.every(stopped) : branchTypes.some(stopped);
}

export function skippedBranches(
  branchIds: readonly string[],
  stoppedIds: ReadonlySet<string>,
): string[] {
  return branchIds.filter((id) => !stoppedIds.has(id));
}
