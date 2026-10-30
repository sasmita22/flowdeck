import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { createRunRelay, stopEngine } from "../../../src/app/main/run.js";

const runState = (status: "running" | "done"): EnginePush => ({
  push: "run-state",
  value: { runId: "run-1", status, nodes: { p1: status === "done" ? "done" : "running" } },
});

describe("createRunRelay", () => {
  it("has no snapshot before the first push", () => {
    const relay = createRunRelay({ send: () => undefined });

    expect(relay.latest()).toBeNull();
  });

  it("sends each pushed snapshot once and keeps the latest", () => {
    const sent: unknown[] = [];
    const relay = createRunRelay({ send: (snapshot) => sent.push(snapshot) });

    relay.onPush(runState("running"));

    expect(sent).toEqual([runState("running").value]);
    expect(relay.latest()).toEqual(runState("running").value);

    relay.onPush(runState("done"));

    expect(sent).toEqual([runState("running").value, runState("done").value]);
    expect(relay.latest()).toEqual(runState("done").value);
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
