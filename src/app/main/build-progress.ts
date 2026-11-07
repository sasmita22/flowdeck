import type { EnginePush } from "../engine/protocol.js";

type BuildProgressUpdate = Omit<Extract<EnginePush, { push: "build-progress" }>, "push">;

export type BuildProgressRelay = {
  onPush(push: EnginePush): void;
  latest(pendingId: string): BuildProgressUpdate | null;
};

export function createBuildProgressRelay(options: {
  send: (update: BuildProgressUpdate) => void;
}): BuildProgressRelay {
  const latest = new Map<string, BuildProgressUpdate>();
  return {
    onPush(push) {
      if (push.push !== "build-progress") return;
      const { pendingId, flowId, progress, buildId } = push;
      const update = { pendingId, flowId, progress, ...(buildId === undefined ? {} : { buildId }) };
      latest.set(update.pendingId, update);
      options.send(update);
    },
    latest(pendingId) {
      return latest.get(pendingId) ?? null;
    },
  };
}
