import type { UsageEntry, UsageReader } from "../core/run/budget.js";

export type { UsageEntry };

export interface UsageSource {
  entries: UsageReader["entries"];
}
