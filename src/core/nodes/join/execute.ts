import type { z } from "zod";
import type { WaitRequest } from "../../run/wait.js";
import type { settings } from "./settings.js";

export type JoinWait = z.infer<typeof settings>["wait"];

export type JoinOnBranchFail = z.infer<typeof settings>["onBranchFail"];

export function notStartedRequest(joinId: string, notStarted: readonly string[]): WaitRequest {
  return {
    nodeId: joinId,
    kind: "ask",
    question: `${notStarted.join(", ")} did not start. Go on without ${notStarted.length === 1 ? "it" : "them"}?`,
    options: ["continue", "stop"],
  };
}

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
