import type { RunSnapshot } from "../../core/run/snapshot.js";
import type { EnginePush } from "../engine/protocol.js";

export type RunRelay = {
  onPush(push: EnginePush): void;
  latest(runId: string): RunSnapshot | null;
};

export function createRunRelay(options: { send: (snapshot: RunSnapshot) => void }): RunRelay {
  const latest = new Map<string, RunSnapshot>();
  return {
    onPush(push) {
      if (push.push !== "run-state") return;
      latest.set(push.value.runId, push.value);
      options.send(push.value);
    },
    latest: (runId) => latest.get(runId) ?? null,
  };
}

export function stopEngine(options: {
  kill: () => void;
  exited: Promise<unknown>;
  timeoutMs: number;
}): Promise<"exited" | "timed-out"> {
  options.kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), options.timeoutMs);
  });
  return Promise.race([options.exited.then(() => "exited" as const), timedOut]).finally(() =>
    clearTimeout(timer),
  );
}
