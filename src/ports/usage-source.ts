import type { UsageEntry, UsageReader } from "../core/run/budget.js";
import type { CompactionReader } from "../core/run/context.js";

export type { UsageEntry };

export interface UsageSource {
  entries: UsageReader["entries"];
  compactions: CompactionReader["compactions"];
}
