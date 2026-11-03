import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { createRunRelay, stopEngine } from "../../../src/app/main/run.js";

const runState = (status: "running" | "done", runId = "run-1"): EnginePush => ({
  push: "run-state",
  value: { runId, status, nodes: { p1: status === "done" ? "done" : "running" } },
});

const snapshotOf = (push: EnginePush) => (push.push === "run-state" ? push.value : null);

describe("createRunRelay", () => {
  it("has no snapshot for a run before its first push", () => {
    const relay = createRunRelay({ send: () => undefined });

    expect(relay.latest("run-1")).toBeNull();
  });

  it("sends each pushed snapshot once and keeps the run's latest", () => {
    const sent: unknown[] = [];
    const relay = createRunRelay({ send: (snapshot) => sent.push(snapshot) });

    relay.onPush(runState("running"));

    expect(sent).toEqual([snapshotOf(runState("running"))]);
    expect(relay.latest("run-1")).toEqual(snapshotOf(runState("running")));

    relay.onPush(runState("done"));

    expect(sent).toEqual([snapshotOf(runState("running")), snapshotOf(runState("done"))]);
    expect(relay.latest("run-1")).toEqual(snapshotOf(runState("done")));
  });

  it("keeps each run's latest snapshot when two runs push in turn", () => {
    const sent: unknown[] = [];
    const relay = createRunRelay({ send: (snapshot) => sent.push(snapshot) });

    relay.onPush(runState("running", "run-1"));
    relay.onPush(runState("running", "run-2"));
    relay.onPush(runState("done", "run-1"));

    expect(relay.latest("run-1")).toEqual(snapshotOf(runState("done", "run-1")));
    expect(relay.latest("run-2")).toEqual(snapshotOf(runState("running", "run-2")));
    expect(relay.latest("run-3")).toBeNull();
    expect(sent).toHaveLength(3);
  });

  it("ignores a session push, sending nothing and keeping the latest snapshot", () => {
    const sent: unknown[] = [];
    const relay = createRunRelay({ send: (snapshot) => sent.push(snapshot) });

    relay.onPush(runState("running"));
    relay.onPush({ push: "session", runId: "run-1", value: "fd-run-x" });

    expect(sent).toEqual([snapshotOf(runState("running"))]);
    expect(relay.latest("run-1")).toEqual(snapshotOf(runState("running")));
  });
});

describe("stopEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the engine once and resolves exited when it exits before the timeout", async () => {
    const kill = vi.fn();
    let exit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => (exit = resolve));

    const stopped = stopEngine({ kill, exited, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(500);
    exit(0);

    await expect(stopped).resolves.toBe("exited");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("resolves timed-out once the timeout passes without the engine exiting", async () => {
    const kill = vi.fn();
    let result: string | undefined;

    void stopEngine({ kill, exited: new Promise(() => undefined), timeoutMs: 1000 }).then(
      (value) => (result = value),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(result).toBe("timed-out");
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
