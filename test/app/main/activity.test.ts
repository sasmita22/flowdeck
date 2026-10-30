import { describe, expect, it } from "vitest";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { createActivityRelay } from "../../../src/app/main/activity.js";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import { subagent, tool } from "../../fixtures/activity-entries.js";

const activity = (entry: ActivityEntry, runId = "run-1"): EnginePush => ({
  push: "activity",
  value: { runId, entry },
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
    relay.onPush({ push: "session", value: "fd-run-x" });

    expect(sent).toEqual([]);
    expect(relay.feed()).toBeNull();
  });

  it("has no feed before the first push", () => {
    expect(setup().relay.feed()).toBeNull();
  });

  it("keeps the run's entries sorted by id ascending", () => {
    const { relay } = setup();

    relay.onPush(activity(tool(2)));
    relay.onPush(activity(tool(1)));
    relay.onPush(activity(tool(3)));

    expect(relay.feed()).toEqual({ runId: "run-1", entries: [tool(1), tool(2), tool(3)] });
  });

  it("replaces an entry pushed again with the same id instead of adding one", () => {
    const { relay, sent } = setup();

    relay.onPush(activity(tool(1)));
    relay.onPush(activity(subagent(2, "running")));
    relay.onPush(activity(subagent(2, "finished")));

    expect(relay.feed()).toEqual({
      runId: "run-1",
      entries: [tool(1), subagent(2, "finished")],
    });
    expect(sent).toHaveLength(3);
  });

  it("starts a new feed when a push carries a different run id", () => {
    const { relay } = setup();

    relay.onPush(activity(tool(1), "run-1"));
    relay.onPush(activity(tool(2), "run-1"));
    relay.onPush(activity(tool(1), "run-2"));

    expect(relay.feed()).toEqual({ runId: "run-2", entries: [tool(1)] });
  });
});
