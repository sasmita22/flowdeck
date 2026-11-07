import { describe, expect, it } from "vitest";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { createBuildProgressRelay } from "../../../src/app/main/build-progress.js";
import {
  progressOf,
  type BuildOutcome,
  type PendingBuild,
  type StoredBuildEvent,
} from "../../../src/core/run/build-progress.js";

const pending = (id: string, outcome?: BuildOutcome): PendingBuild => ({
  id,
  flowId: "flow-1",
  version: 1,
  name: "fix-login",
  origin: null,
  startedAt: 0,
  ...(outcome === undefined ? {} : { outcome }),
});

const atStep = (step: 1 | 2 | 3 | 4 | 5): StoredBuildEvent[] => [
  { type: "step", step, status: "running", seq: 1, at: 0 },
];

const progressPush = (
  pendingId: string,
  step: 1 | 2 | 3 | 4 | 5,
  buildId?: string,
): EnginePush => ({
  push: "build-progress",
  pendingId,
  flowId: "flow-1",
  progress: progressOf(
    pending(pendingId, buildId === undefined ? undefined : "built"),
    atStep(step),
  ),
  ...(buildId === undefined ? {} : { buildId }),
});

const updateOf = (push: EnginePush) => {
  if (push.push !== "build-progress") throw new Error("not a build-progress push");
  const { pendingId, flowId, progress, buildId } = push;
  return { pendingId, flowId, progress, ...(buildId === undefined ? {} : { buildId }) };
};

const setup = () => {
  const sent: unknown[] = [];
  const relay = createBuildProgressRelay({ send: (update) => sent.push(update) });
  return { relay, sent };
};

describe("createBuildProgressRelay", () => {
  it("sends each build-progress push once, without its push kind", () => {
    const { relay, sent } = setup();
    const push = progressPush("pending-1", 2);

    relay.onPush(push);

    expect(sent).toEqual([updateOf(push)]);
  });

  it("ignores other pushes, sending nothing and keeping nothing", () => {
    const { relay, sent } = setup();

    relay.onPush({ push: "run-state", value: { runId: "run-1", status: "running", nodes: {} } });
    relay.onPush({ push: "session", runId: "run-1", value: "fd-run-x" });

    expect(sent).toEqual([]);
    expect(relay.latest("run-1")).toBeNull();
  });

  it("has nothing for a pending build before its first push", () => {
    expect(setup().relay.latest("pending-1")).toBeNull();
  });

  it("keeps only the latest push of a pending build, with its build id once built", () => {
    const { relay, sent } = setup();
    const built = progressPush("pending-1", 5, "build-1");

    relay.onPush(progressPush("pending-1", 1));
    relay.onPush(progressPush("pending-1", 3));
    relay.onPush(built);

    expect(relay.latest("pending-1")).toEqual(updateOf(built));
    expect(sent).toHaveLength(3);
  });

  it("keeps each pending build apart when two build in turn", () => {
    const { relay, sent } = setup();
    const first = progressPush("pending-1", 4);
    const second = progressPush("pending-2", 2);

    relay.onPush(progressPush("pending-1", 1));
    relay.onPush(progressPush("pending-2", 1));
    relay.onPush(first);
    relay.onPush(second);

    expect(relay.latest("pending-1")).toEqual(updateOf(first));
    expect(relay.latest("pending-2")).toEqual(updateOf(second));
    expect(relay.latest("pending-3")).toBeNull();
    expect(sent).toHaveLength(4);
  });
});
