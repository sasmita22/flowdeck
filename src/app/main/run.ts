import type { EnginePush } from "../engine/protocol.js";

export type RunRelay = { onPush(push: EnginePush): void; latest(): unknown };

export function createRunRelay(options: { send: (snapshot: unknown) => void }): RunRelay {
  let latest: unknown = null;
  return {
    onPush(push) {
      latest = push.value;
      options.send(push.value);
    },
    latest: () => latest,
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
