import { describe, expect, it } from "vitest";
import { attribute, trackWindow, type NodeWindow } from "../../../src/core/run/attribution.js";

type Mark = [nodeId: string, kind: string, at: number];

const windowsFrom = (marks: readonly Mark[]): NodeWindow[] =>
  marks.reduce<NodeWindow[]>(
    (windows, [nodeId, kind, at]) => trackWindow(windows, nodeId, kind, at),
    [],
  );

const threeNodes: Mark[] = [
  ["p1", "sent", 100],
  ["p1", "done", 200],
  ["p2", "sent", 300],
  ["p2", "done", 400],
  ["p3", "sent", 500],
  ["p3", "done", 600],
];

describe("attribute", () => {
  const windows = windowsFrom(threeNodes);

  it.each([
    [300, "p2"],
    [399, "p2"],
    [299, undefined],
    [400, undefined],
    [199, "p1"],
    [500, "p3"],
  ])("places a stamp of %i on %s, inclusive at send and exclusive at turn end", (stamp, node) => {
    expect(attribute(windows, stamp)).toBe(node);
  });

  it.each([50, 450, 700])("drops a stamp of %i that is outside every window", (stamp) => {
    expect(attribute(windows, stamp)).toBeUndefined();
  });

  it("places a stamp by its time, not by when it arrives", () => {
    const p3Open = windowsFrom([...threeNodes.slice(0, 4), ["p3", "sent", 500]]);

    expect(attribute(p3Open, 350)).toBe("p2");
  });

  it("places any later stamp on a window that has not ended", () => {
    const open = windowsFrom([...threeNodes.slice(0, 2), ["p2", "sent", 300]]);

    expect(attribute(open, 10_000)).toBe("p2");
  });

  it("closes a window on failed as it does on done", () => {
    const failed = windowsFrom([
      ["p2", "sent", 300],
      ["p2", "failed", 400],
    ]);

    expect(attribute(failed, 399)).toBe("p2");
    expect(attribute(failed, 400)).toBeUndefined();
  });

  it("keeps one window per send for a node sent again in a loop", () => {
    const loop = windowsFrom([
      ["p2", "sent", 300],
      ["p2", "done", 400],
      ["p2", "sent", 500],
      ["p2", "done", 600],
    ]);

    expect(attribute(loop, 550)).toBe("p2");
    expect(attribute(loop, 450)).toBeUndefined();
  });
});

describe("attribute with an owner", () => {
  const section = windowsFrom([
    ["fork", "sent", 100],
    ["a1", "sent", 100],
    ["a2", "sent", 100],
  ]);

  it("places a stamp on the owner when its open window covers the stamp", () => {
    expect(attribute(section, 150, "a2")).toBe("a2");
  });

  it("places a stamp with no owner on the first open window", () => {
    expect(attribute(section, 150)).toBe("fork");
  });

  it("falls back to the first open window when no window of the owner covers the stamp", () => {
    expect(attribute(section, 150, "a3")).toBe("fork");
    expect(
      attribute(windowsFrom([...threeNodes.slice(0, 2), ["p2", "sent", 300]]), 350, "p1"),
    ).toBe("p2");
  });
});

describe("trackWindow", () => {
  it("closes a window on skipped as it does on done", () => {
    const skipped = trackWindow(
      windowsFrom([
        ["fork", "sent", 100],
        ["a1", "sent", 100],
        ["a2", "sent", 100],
      ]),
      "a1",
      "skipped",
      300,
    );

    expect(skipped).toEqual([
      { nodeId: "fork", sentAt: 100 },
      { nodeId: "a1", sentAt: 100, endedAt: 300 },
      { nodeId: "a2", sentAt: 100 },
    ]);
  });

  it.each(["running", "reset"])("leaves the windows unchanged on %s", (kind) => {
    const before = windowsFrom([["p2", "sent", 300]]);

    expect(trackWindow(before, "p2", kind, 400)).toEqual(before);
    expect(attribute(trackWindow(before, "p2", kind, 400), 10_000)).toBe("p2");
  });

  it("returns new windows without changing the ones it was given", () => {
    const before = windowsFrom([["p2", "sent", 300]]);
    const snapshot = structuredClone(before);

    trackWindow(before, "p2", "done", 400);

    expect(before).toEqual(snapshot);
  });
});
