import {
  buildProgressEntrySchema,
  type BuildProgressEntry,
} from "../../core/run/build-progress.js";
import type { EnginePush } from "../engine/protocol.js";

export type BuildProgressRelay = {
  onPush(push: EnginePush): void;
  latest(pendingId: string): BuildProgressEntry | null;
};

export function createBuildProgressRelay(options: {
  send: (update: BuildProgressEntry) => void;
}): BuildProgressRelay {
  const latest = new Map<string, BuildProgressEntry>();
  return {
    onPush(push) {
      if (push.push !== "build-progress") return;
      const update = buildProgressEntrySchema.parse(push);
      latest.set(update.pendingId, update);
      options.send(update);
    },
    latest(pendingId) {
      return latest.get(pendingId) ?? null;
    },
  };
}
