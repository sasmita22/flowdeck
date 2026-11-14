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
      const { pendingId, name, startedAt, events, progress } = push;
      const update: BuildProgressUpdate = {
        pendingId,
        name,
        startedAt,
        ...(push.endedAt === undefined ? {} : { endedAt: push.endedAt }),
        ...(push.outcome === undefined ? {} : { outcome: push.outcome }),
        ...(push.blueprintName === undefined ? {} : { blueprintName: push.blueprintName }),
        ...(push.blueprintVersion === undefined ? {} : { blueprintVersion: push.blueprintVersion }),
        events,
        progress,
        ...(push.buildId === undefined ? {} : { buildId: push.buildId }),
      };
      latest.set(update.pendingId, update);
      options.send(update);
    },
    latest(pendingId) {
      return latest.get(pendingId) ?? null;
    },
  };
}
