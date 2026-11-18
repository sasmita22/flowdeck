import { describe, expect, it } from "vitest";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { createActivityRelay } from "../../../src/app/main/activity.js";
import type { SnapshotStatus } from "../../../src/core/run/snapshot.js";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import { subagent, tool } from "../../fixtures/activity-entries.js";

const activity = (entry: ActivityEntry, runId = "run-1"): EnginePush => ({
  push: "activity",
  value: { runId, entry },
});

const runState = (status: SnapshotStatus, runId = "run-1"): EnginePush => ({
  push: "run-state",
  value: { runId, status, nodes: {} },
});

const setup = () => {
  const sent: unknown[] = [];
  const relay = createActivityRelay({ send: (update) => sent.push(update) });
  return { relay, sent };
};

describe("createActivityRelay", () => {
  it("sends each activity push once, unchanged", () => {
    const { relay, sent } = setup();

    relay.onPush(activity(tool(1)));

    expect(sent).toEqual([{ runId: "run-1", entry: tool(1) }]);
  });

  it("ignores run-state and session pushes, sending nothing and keeping no feed", () => {
    const { relay, sent } = setup();

    relay.onPush({ push: "run-state", value: { runId: "run-1", status: "running", nodes: {} } });
    relay.onPush({ push: "session", runId: "run-1", value: "fd-run-x" });

    expect(sent).toEqual([]);
    expect(relay.feed("run-1")).toBeNull();
  });

  it("has no feed for a run before its first push", () => {
    expect(setup().relay.feed("run-1")).toBeNull();
  });

  it("keeps the run's entries sorted by id ascending", () => {
    const { relay } = setup();

    relay.onPush(activity(tool(2)));
    relay.onPush(activity(tool(1)));
    relay.onPush(activity(tool(3)));

    expect(relay.feed("run-1")).toEqual({ runId: "run-1", entries: [tool(1), tool(2), tool(3)] });
  });

  it("replaces an entry pushed again with the same id instead of adding one", () => {
    const { relay, sent } = setup();

    relay.onPush(activity(tool(1)));
    relay.onPush(activity(subagent(2, "running")));
    relay.onPush(activity(subagent(2, "finished")));

    expect(relay.feed("run-1")).toEqual({
      runId: "run-1",
      entries: [tool(1), subagent(2, "finished")],
    });
    expect(sent).toHaveLength(3);
  });

  it("keeps each run's entries apart when two runs push in turn", () => {
    const { relay, sent } = setup();

    relay.onPush(activity(tool(1), "run-1"));
    relay.onPush(activity(tool(2), "run-1"));
    relay.onPush(activity(tool(1), "run-2"));
    relay.onPush(activity(tool(3), "run-1"));

    expect(relay.feed("run-1")).toEqual({ runId: "run-1", entries: [tool(1), tool(2), tool(3)] });
    expect(relay.feed("run-2")).toEqual({ runId: "run-2", entries: [tool(1)] });
    expect(relay.feed("run-3")).toBeNull();
    expect(sent).toHaveLength(4);
  });

  it.each(["done", "failed", "stopped"] as const)(
    "has no feed for a run once it reaches %s",
    (status) => {
      const { relay } = setup();
      relay.onPush(activity(tool(1)));
      relay.onPush(activity(tool(2)));

      relay.onRunState(runState(status));

      expect(relay.feed("run-1")).toBeNull();
    },
  );

  it("keeps no activity that arrives after the run has ended", () => {
    const { relay } = setup();
    relay.onPush(activity(tool(1)));
    relay.onRunState(runState("done"));

    relay.onPush(activity(tool(2)));

    expect(relay.feed("run-1")).toBeNull();
  });

  it("keeps activity again once an ended run is running again", () => {
    const { relay } = setup();
    relay.onPush(activity(tool(1)));
    relay.onRunState(runState("stopped"));
    relay.onPush(activity(tool(2)));

    relay.onRunState(runState("running"));
    relay.onPush(activity(tool(3)));

    expect(relay.feed("run-1")).toEqual({ runId: "run-1", entries: [tool(3)] });
  });

  it("keeps every entry of a running run, sorted", () => {
    const { relay } = setup();
    relay.onRunState(runState("running"));

    for (let id = 3000; id >= 1; id -= 1) relay.onPush(activity(tool(id)));

    const entries = relay.feed("run-1")?.entries ?? [];
    expect(entries).toHaveLength(3000);
    expect(entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: 3000 }, (_, index) => index + 1),
    );
  });

  it("leaves another run's feed alone when one run ends", () => {
    const { relay } = setup();
    relay.onPush(activity(tool(1), "run-a"));
    relay.onPush(activity(tool(1), "run-b"));
    relay.onPush(activity(tool(2), "run-b"));

    relay.onRunState(runState("failed", "run-a"));

    expect(relay.feed("run-a")).toBeNull();
    expect(relay.feed("run-b")).toEqual({ runId: "run-b", entries: [tool(1), tool(2)] });
  });
});
