import { describe, expect, it } from "vitest";
import {
  runSnapshot,
  runSnapshotSchema,
  startRunResultSchema,
} from "../../../src/core/run/snapshot.js";
import { nodeStatus, type RunEvent } from "../../../src/core/run/run-events.js";

const valid = {
  runId: "run-1",
  status: "running",
  nodes: { s1: "running", p1: "sent", p2: "waiting" },
};

describe("runSnapshot", () => {
  it("shows every node waiting before any event", () => {
    expect(
      runSnapshot({ runId: "run-1", status: "running", nodeIds: ["s1", "p1"], events: [] }),
    ).toEqual({ runId: "run-1", status: "running", nodes: { s1: "waiting", p1: "waiting" } });
  });

  it("derives each node's state from that node's events", () => {
    const events: (RunEvent & { nodeId: string })[] = [
      { nodeId: "s0", kind: "running" },
      { nodeId: "s0", kind: "done" },
      { nodeId: "s1", kind: "running" },
      { nodeId: "p1", kind: "sent" },
    ];

    const snapshot = runSnapshot({
      runId: "run-1",
      status: "running",
      nodeIds: ["s0", "s1", "p1", "p2"],
      events,
    });

    expect(snapshot.nodes).toEqual({
      s0: nodeStatus(events.filter((event) => event.nodeId === "s0")),
      s1: "running",
      p1: "sent",
      p2: "waiting",
    });
    expect(snapshot.nodes["s0"]).toBe("done");
  });

  it("ignores events for unknown nodes and passes the run id and status through", () => {
    const events: (RunEvent & { nodeId: string })[] = [
      { nodeId: "ghost", kind: "running" },
      { nodeId: "s1", kind: "running" },
      { nodeId: "s1", kind: "failed", payload: { message: "exit 1" } },
    ];

    expect(runSnapshot({ runId: "run-7", status: "failed", nodeIds: ["s1"], events })).toEqual({
      runId: "run-7",
      status: "failed",
      nodes: { s1: "failed" },
    });
  });
});

describe("runSnapshotSchema", () => {
  it("accepts a valid snapshot", () => {
    expect(runSnapshotSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown run status", () => {
    expect(runSnapshotSchema.safeParse({ ...valid, status: "paused" }).success).toBe(false);
  });

  it("rejects an unknown node state", () => {
    expect(runSnapshotSchema.safeParse({ ...valid, nodes: { s1: "needs you" } }).success).toBe(
      false,
    );
  });

  it("rejects a snapshot without a run id", () => {
    expect(runSnapshotSchema.safeParse({ status: valid.status, nodes: valid.nodes }).success).toBe(
      false,
    );
  });
});

describe("startRunResultSchema", () => {
  it.each([
    { kind: "started", runId: "run-1" },
    { kind: "error", message: "Save the flow before running it" },
  ])("accepts %j", (value) => {
    expect(startRunResultSchema.parse(value)).toEqual(value);
  });

  it.each([
    { kind: "started" },
    { kind: "error" },
    { kind: "started", message: "x" },
    { kind: "done", runId: "run-1" },
    "started",
    null,
  ])("rejects %j", (value) => {
    expect(startRunResultSchema.safeParse(value).success).toBe(false);
  });
});
