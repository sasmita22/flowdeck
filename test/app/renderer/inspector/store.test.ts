import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import {
  createInspectorStore,
  selectActivity,
} from "../../../../src/app/renderer/inspector/store.js";
import type { ActivityEntry } from "../../../../src/core/run/activity.js";
import { subagent, tool } from "../../../fixtures/activity-entries.js";

type InspectorBridge = Pick<FlowdeckBridge, "getActivity" | "onActivity">;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const update = (entry: ActivityEntry, runId = "run-1") => ({ runId, entry });

const setup = () => {
  const calls: string[] = [];
  let pushListener: (value: unknown) => void = () => undefined;

  const bridge = {
    getActivity: vi.fn<() => Promise<unknown>>(async () => {
      calls.push("getActivity");
      return null;
    }),
    onActivity: vi.fn((listener: (value: unknown) => void) => {
      calls.push("onActivity");
      pushListener = listener;
      return () => {};
    }),
  } satisfies InspectorBridge;

  const inspector = createInspectorStore({ bridge });
  const push = (value: unknown) => pushListener(value);
  const activity = (runId: string | undefined) => selectActivity(inspector.getState(), runId);

  return { bridge, inspector, calls, push, activity };
};

const connected = async () => {
  const context = setup();
  await context.inspector.getState().connect();
  return context;
};

describe("connect", () => {
  it("subscribes to activity pushes before asking for the current feed", async () => {
    const { calls } = await connected();

    expect(calls).toEqual(["onActivity", "getActivity"]);
  });

  it("shows the feed getActivity returns when no push came first", async () => {
    const { bridge, inspector, activity } = setup();
    bridge.getActivity.mockResolvedValueOnce({ runId: "run-1", entries: [tool(1), tool(2)] });

    await inspector.getState().connect();

    expect(activity("run-1")).toEqual([tool(2), tool(1)]);
  });

  it("merges a fetched feed under pushes that arrived before it answered", async () => {
    const { bridge, inspector, push, activity } = setup();
    const answer = deferred<unknown>();
    bridge.getActivity.mockReturnValueOnce(answer.promise);

    const connecting = inspector.getState().connect();
    push(update(subagent(3, "finished")));
    answer.resolve({ runId: "run-1", entries: [tool(1), tool(2), subagent(3, "running")] });
    await connecting;

    expect(activity("run-1")).toEqual([subagent(3, "finished"), tool(2), tool(1)]);
  });

  it("leaves the state unchanged when getActivity answers null", async () => {
    const { bridge, inspector, push, activity } = setup();
    const answer = deferred<unknown>();
    bridge.getActivity.mockReturnValueOnce(answer.promise);

    const connecting = inspector.getState().connect();
    push(update(tool(1)));
    answer.resolve(null);
    await connecting;

    expect(activity("run-1")).toEqual([tool(1)]);
  });

  it("ignores a fetched feed that is not an activity feed", async () => {
    const { bridge, inspector } = setup();
    bridge.getActivity.mockResolvedValueOnce({ runId: "run-1", entries: "none" });

    await inspector.getState().connect();

    expect(inspector.getState().feed).toBeNull();
  });
});

describe("activity pushes", () => {
  it("stores a valid update", async () => {
    const { push, activity } = await connected();

    push(update(tool(1)));

    expect(activity("run-1")).toEqual([tool(1)]);
  });

  it("ignores updates that fail the activity update schema", async () => {
    const { inspector, push, activity } = await connected();

    push({ runId: "run-1", entry: { ...tool(1), kind: "thought" } });
    push({ entry: tool(1) });
    push("done");

    expect(inspector.getState().feed).toBeNull();

    push(update(tool(1)));
    push({ runId: "run-1", entry: { ...tool(2), id: "two" } });

    expect(activity("run-1")).toEqual([tool(1)]);
  });

  it("replaces the entry with the same id instead of adding one", async () => {
    const { push, activity } = await connected();

    push(update(subagent(1, "running")));
    push(update(tool(2)));
    push(update(subagent(1, "finished")));

    expect(activity("run-1")).toEqual([tool(2), subagent(1, "finished")]);
  });

  it("replaces the feed when an update carries a new run id", async () => {
    const { push, activity } = await connected();

    push(update(tool(1), "run-1"));
    push(update(tool(2), "run-1"));
    push(update(tool(1), "run-2"));

    expect(activity("run-2")).toEqual([tool(1)]);
    expect(activity("run-1")).toEqual([]);
  });
});

describe("selectActivity", () => {
  it("returns the entries newest first when the run id matches", async () => {
    const { push, activity } = await connected();

    push(update(tool(2)));
    push(update(tool(1)));
    push(update(tool(3)));

    expect(activity("run-1").map((entry) => entry.id)).toEqual([3, 2, 1]);
  });

  it("returns no entries for another run id, no run id, or before any feed", async () => {
    const { push, activity } = await connected();

    expect(activity("run-1")).toEqual([]);

    push(update(tool(1)));

    expect(activity("run-2")).toEqual([]);
    expect(activity(undefined)).toEqual([]);
  });
});
