import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import {
  createInspectorStore,
  entryText,
  selectActivity,
  selectFiles,
  stepsEndedOf,
} from "../../../../src/app/renderer/inspector/store.js";
import type { DisplayStatus } from "../../../../src/core/run/display.js";
import type { SnapshotStatus } from "../../../../src/core/run/snapshot.js";
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
    getActivity: vi.fn<(runId: string) => Promise<unknown>>(async (runId) => {
      calls.push(`getActivity ${runId}`);
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

const connected = async (runId = "run-1") => {
  const context = setup();
  await context.inspector.getState().connect();
  await context.inspector.getState().view(runId);
  return context;
};

describe("view", () => {
  it("subscribes to activity pushes, then asks for the viewed run's feed", async () => {
    const { calls, inspector } = await connected("run-1");

    expect(calls).toEqual(["onActivity", "getActivity run-1"]);
    expect(inspector.getState().runId).toBe("run-1");
  });

  it("shows the feed getActivity returns when no push came first", async () => {
    const { bridge, inspector, activity } = setup();
    bridge.getActivity.mockResolvedValueOnce({ runId: "run-1", entries: [tool(1), tool(2)] });
    await inspector.getState().connect();

    await inspector.getState().view("run-1");

    expect(activity("run-1")).toEqual([tool(2), tool(1)]);
  });

  it("merges a fetched feed under pushes that arrived before it answered", async () => {
    const { bridge, inspector, push, activity } = setup();
    await inspector.getState().connect();
    const answer = deferred<unknown>();
    bridge.getActivity.mockReturnValueOnce(answer.promise);

    const viewing = inspector.getState().view("run-1");
    push(update(subagent(3, "finished")));
    answer.resolve({ runId: "run-1", entries: [tool(1), tool(2), subagent(3, "running")] });
    await viewing;

    expect(activity("run-1")).toEqual([subagent(3, "finished"), tool(2), tool(1)]);
  });

  it("leaves the state unchanged when getActivity answers null", async () => {
    const { bridge, inspector, push, activity } = setup();
    await inspector.getState().connect();
    const answer = deferred<unknown>();
    bridge.getActivity.mockReturnValueOnce(answer.promise);

    const viewing = inspector.getState().view("run-1");
    push(update(tool(1)));
    answer.resolve(null);
    await viewing;

    expect(activity("run-1")).toEqual([tool(1)]);
  });

  it("ignores a fetched feed that is not an activity feed", async () => {
    const { bridge, inspector } = setup();
    bridge.getActivity.mockResolvedValueOnce({ runId: "run-1", entries: "none" });
    await inspector.getState().connect();

    await inspector.getState().view("run-1");

    expect(inspector.getState().feed).toBeNull();
  });

  it("switching to another run shows that run's feed, fetched for it", async () => {
    const { bridge, inspector, push, activity } = await connected("run-1");
    push(update(tool(1), "run-1"));
    bridge.getActivity.mockResolvedValueOnce({ runId: "run-2", entries: [tool(5)] });

    await inspector.getState().view("run-2");

    expect(bridge.getActivity).toHaveBeenLastCalledWith("run-2");
    expect(activity("run-2")).toEqual([tool(5)]);
    expect(activity("run-1")).toEqual([]);
  });

  it("ignores a late feed for a run no longer viewed", async () => {
    const { bridge, inspector, activity } = setup();
    await inspector.getState().connect();
    const late = deferred<unknown>();
    bridge.getActivity.mockReturnValueOnce(late.promise);
    bridge.getActivity.mockResolvedValueOnce({ runId: "run-2", entries: [tool(5)] });

    const first = inspector.getState().view("run-1");
    await inspector.getState().view("run-2");
    late.resolve({ runId: "run-1", entries: [tool(1)] });
    await first;

    expect(activity("run-2")).toEqual([tool(5)]);
    expect(inspector.getState().feed?.runId).toBe("run-2");
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

  it("keeps the viewed run's feed when another run's update arrives", async () => {
    const { push, activity } = await connected("run-1");

    push(update(tool(1), "run-1"));
    push(update(tool(2), "run-1"));
    push(update(tool(1), "run-2"));

    expect(activity("run-1")).toEqual([tool(2), tool(1)]);
    expect(activity("run-2")).toEqual([]);
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

describe("selectActivity with stored entries", () => {
  it("merges the run's stored entries under the live ones, newest first", async () => {
    const { push, inspector } = await connected();
    push(update({ ...subagent(2, "finished") }));
    push(update(tool(3)));

    const stored = [tool(1), subagent(2, "running")];

    expect(
      selectActivity(inspector.getState(), "run-1", stored).map((entry) => [entry.id, entry.kind]),
    ).toEqual([
      [3, "tool"],
      [2, "subagent"],
      [1, "tool"],
    ]);
    expect(selectActivity(inspector.getState(), "run-1", stored)[1]).toMatchObject({
      state: "finished",
    });
    expect(selectActivity(inspector.getState(), "run-9", stored).map((entry) => entry.id)).toEqual([
      2, 1,
    ]);
  });
});

const counting = <K extends "sort" | "set">(
  target: { [key in K]: (...args: never[]) => unknown },
  key: K,
) => {
  const original = target[key];
  let calls = 0;
  target[key] = function (this: unknown, ...args: never[]) {
    calls += 1;
    return Reflect.apply(original, this, args);
  } as (typeof target)[K];
  return {
    calls: () => calls,
    restore: () => {
      target[key] = original;
    },
  };
};

const runningIds = Array.from({ length: 100 }, (_, index) => (index + 1) * 2);
const toolIds = Array.from({ length: 4_900 }, (_, index) => (index + 101) * 2);
const lateId = 4_001;

const pushLongRun = (push: (value: unknown) => void) => {
  for (const id of runningIds) push(update(subagent(id, "running")));
  for (const id of toolIds) push(update(tool(id)));
  for (const id of runningIds) push(update(subagent(id, "finished")));
  push(update(tool(lateId)));
};

const longRunPushes = runningIds.length + toolIds.length + runningIds.length + 1;

describe("merging a long run", () => {
  it("never sorts, sets the index map a bounded number of times, and reuses the selected list", async () => {
    const { push, inspector } = await connected();
    const stored = [tool(1)];
    const sorts = counting(Array.prototype, "sort");
    const sets = counting(Map.prototype, "set");
    let first: ActivityEntry[];
    let repeats: ActivityEntry[][];
    try {
      pushLongRun(push);
      first = selectActivity(inspector.getState(), "run-1", stored);
      repeats = Array.from({ length: 50 }, () =>
        selectActivity(inspector.getState(), "run-1", stored),
      );
    } finally {
      sorts.restore();
      sets.restore();
    }

    expect.soft(sorts.calls()).toBe(0);
    expect.soft(sets.calls()).toBeLessThanOrEqual(4 * longRunPushes);
    expect.soft(repeats.every((repeat) => repeat === first)).toBe(true);
  });

  it("orders the feed by id without duplicates, finish rows in place of start rows", async () => {
    const { push, activity } = await connected();

    pushLongRun(push);

    const ids = activity("run-1").map((entry) => entry.id);
    const expected = [...runningIds, ...toolIds, lateId].sort((a, b) => b - a);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    const finished = activity("run-1").filter((entry) => entry.kind === "subagent");
    expect(finished).toHaveLength(runningIds.length);
    expect(finished.every((entry) => entry.kind === "subagent" && entry.state === "finished")).toBe(
      true,
    );
  });

  it("grows the live entries by one per new id and keeps the length on a replace", async () => {
    const { push, inspector } = await connected();
    const length = () => inspector.getState().feed?.entries.length ?? 0;

    push(update(subagent(2, "running")));
    push(update(tool(4)));
    expect(length()).toBe(2);

    push(update(subagent(2, "finished")));
    expect(length()).toBe(2);

    push(update(tool(3)));
    expect(length()).toBe(3);

    push(update(tool(3)));
    expect(length()).toBe(3);
  });

  it("merges stored entries with live ones, a live entry winning over a stored one with its id", async () => {
    const { push, inspector } = await connected();
    const stored = [tool(1), subagent(2, "running"), tool(5), subagent(7, "running")];

    push(update(subagent(2, "finished")));
    push(update(tool(3)));
    push(update(tool(6)));
    push(update(subagent(7, "finished")));
    push(update(tool(8)));

    expect(selectActivity(inspector.getState(), "run-1", stored)).toEqual([
      tool(8),
      subagent(7, "finished"),
      tool(6),
      tool(5),
      tool(3),
      subagent(2, "finished"),
      tool(1),
    ]);
  });
});

describe("entryText", () => {
  const base = { id: 1, nodeId: "p1", at: 1 };

  it.each<[ActivityEntry, string]>([
    [tool(1), "Bash ls"],
    [subagent(1, "running"), "general-purpose Run a1 running"],
    [{ ...base, kind: "turn", summary: "Wrote it." }, "Turn ended: Wrote it."],
    [
      { ...base, kind: "failure", summary: "Script exited with code 3" },
      "Failed: Script exited with code 3",
    ],
    [
      { ...base, kind: "context", summary: "Context compacted at 162k tokens" },
      "Context compacted at 162k tokens",
    ],
    [
      { ...base, kind: "pr", url: "https://x/pull/1", summary: "https://x/pull/1" },
      "Opened https://x/pull/1",
    ],
    [
      {
        ...base,
        kind: "kept",
        summary: "Kept the branch flowdeck/abcd1234: it holds this run's commits.",
      },
      "Kept the branch flowdeck/abcd1234: it holds this run's commits.",
    ],
  ])("says %j as %j", (entry, text) => {
    expect(entryText(entry)).toBe(text);
  });

  const traced: Extract<ActivityEntry, { kind: "tool" }> = {
    ...base,
    kind: "tool",
    tool: "Bash",
    summary: "ls",
    input: '{"command":"ls"}',
  };

  it.each<[ActivityEntry, string]>([
    [{ ...traced, output: "a.ts", result: "ok", durationMs: 1234 }, "Bash ls · ok · 1.2s"],
    [
      { ...traced, output: "no such file", result: "error", durationMs: 1234 },
      "Bash ls · error · 1.2s",
    ],
    [traced, "Bash ls · running"],
  ])("says a traced step %j as %j", (entry, text) => {
    expect(entryText(entry)).toBe(text);
  });

  it("says a step with no result has none once its run or stage has ended, and keeps a result", () => {
    expect(entryText(traced, { ended: true })).toBe("Bash ls · no result");
    expect(entryText({ ...traced, result: "ok", durationMs: 1234 }, { ended: true })).toBe(
      "Bash ls · ok · 1.2s",
    );
    expect(entryText(tool(1), { ended: true })).toBe("Bash ls");
  });
});

describe("stepsEndedOf", () => {
  it.each<[SnapshotStatus | undefined, DisplayStatus | undefined, boolean]>([
    ["running", "running", false],
    ["running", "done", true],
    ["running", "failed", true],
    ["done", undefined, true],
    ["failed", undefined, true],
    ["stopped", undefined, false],
    ["stopped", "stopped", false],
    ["interrupted", undefined, false],
    [undefined, undefined, false],
  ])("says steps of a %s run in a %s stage ended: %s", (run, stage, ended) => {
    expect(stepsEndedOf(run, stage)).toBe(ended);
  });
});

describe("selectFiles", () => {
  it("lists each node's written files once, in node order, and the pull requests", () => {
    const write = (id: number, nodeId: string, tool: string, path: string): ActivityEntry => ({
      id,
      nodeId,
      at: id,
      kind: "tool",
      tool,
      summary: path,
      path,
    });

    const files = selectFiles(
      [
        write(1, "p2", "Write", "/repo/b.ts"),
        write(2, "p1", "Edit", "/repo/a.ts"),
        write(3, "p2", "Edit", "/repo/b.ts"),
        tool(4),
        {
          id: 5,
          nodeId: "p2",
          at: 5,
          kind: "pr",
          url: "https://x/pull/7",
          summary: "https://x/pull/7",
        },
      ],
      ["p1", "p2"],
    );

    expect(files).toEqual({
      nodes: [
        { nodeId: "p1", paths: ["/repo/a.ts"] },
        { nodeId: "p2", paths: ["/repo/b.ts"] },
      ],
      pullRequests: [{ nodeId: "p2", url: "https://x/pull/7" }],
    });
  });
});
