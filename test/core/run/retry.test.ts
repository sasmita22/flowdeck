import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import { resumeEntries, retryEntries } from "../../../src/core/run/retry.js";
import { nodeStatus, type RunEvent } from "../../../src/core/run/run-events.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

const node = (id: string, type: ManifestNode["type"], parent?: string) =>
  ({
    id,
    type,
    label: id,
    settings: {},
    ...(parent === undefined ? {} : { parent }),
  }) as ManifestNode;

const then = (from: string, to: string) => ({
  kind: "then" as const,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function stored(entries: [string, RunEvent][]): StoredEvent[] {
  return entries.map(([nodeId, event], i) => ({ ...event, nodeId, seq: i + 1, time: "t" }));
}

const failed = (nodeId: string, cause = "exit code 3"): [string, RunEvent] => [
  nodeId,
  { kind: "failed", payload: { message: `${nodeId} failed: ${cause}` } },
];

const kinds = (entries: { nodeId: string; event: RunEvent }[]) =>
  entries.map(({ nodeId, event }) => `${nodeId} ${event.kind}`);

describe("retryEntries", () => {
  it("retries only the failed node of a plain sequence", () => {
    const manifest = {
      nodes: [node("s1", "script"), node("s2", "script")],
      wires: [then("s1", "s2")],
    };
    const events = stored([
      ["s1", { kind: "running" }],
      ["s1", { kind: "done" }],
      ["s2", { kind: "running" }],
      failed("s2"),
    ]);

    expect(kinds(retryEntries(manifest, events, "s2"))).toEqual(["s2 retry"]);
  });

  it("refuses a node that has not failed", () => {
    const manifest = { nodes: [node("s1", "script")], wires: [] };

    expect(() => retryEntries(manifest, stored([["s1", { kind: "running" }]]), "s1")).toThrow(
      /s1 has not failed/,
    );
  });

  it("retries the failed loop around a failed body node, from either of them", () => {
    const manifest = {
      nodes: [node("l1", "loop"), node("p1", "prompt", "l1"), node("s1", "script", "l1")],
      wires: [],
    };
    const events = stored([
      ["l1", { kind: "running" }],
      ["p1", { kind: "sent" }],
      ["p1", { kind: "done" }],
      ["s1", { kind: "running" }],
      failed("s1"),
      failed("l1", "s1 failed: exit code 3"),
    ]);

    expect(kinds(retryEntries(manifest, events, "s1")).sort()).toEqual(["l1 retry", "s1 retry"]);
    expect(kinds(retryEntries(manifest, events, "l1")).sort()).toEqual(["l1 retry", "s1 retry"]);
  });
});

describe("retryEntries in a parallel section", () => {
  const section = (branches: string[]) => ({
    nodes: [node("f", "fork"), ...branches.map((id) => node(id, "agent")), node("j", "join")],
    wires: [...branches.map((id) => then("f", id)), ...branches.map((id) => then(id, "j"))],
  });

  const sorted = (entries: { nodeId: string; event: RunEvent }[]) => kinds(entries).sort();

  const replays = (events: StoredEvent[], entries: { nodeId: string; event: RunEvent }[]) => {
    const all = [...events, ...entries.map(({ nodeId, event }) => ({ ...event, nodeId }))];
    return Object.fromEntries(
      [...new Set(all.map((event) => event.nodeId))].map((id) => [
        id,
        nodeStatus(all.filter((event) => event.nodeId === id)),
      ]),
    );
  };

  const oneDoneOneFailed = stored([
    ["f", { kind: "sent" }],
    ["a", { kind: "sent" }],
    ["b", { kind: "sent" }],
    ["j", { kind: "running" }],
    ["a", { kind: "done" }],
    failed("b", "no Stop"),
    failed("j", "no Stop"),
    failed("f", "no Stop"),
  ]);

  it.each(["b", "f", "j"])(
    "retrying %s resets the fork and join and reruns the failed branch, not the done one",
    (nodeId) => {
      const entries = retryEntries(section(["a", "b"]), oneDoneOneFailed, nodeId);

      expect(sorted(entries)).toEqual(["b retry", "f retry", "j retry"]);
      expect(replays(oneDoneOneFailed, entries)).toEqual({
        f: "waiting",
        a: "done",
        b: "waiting",
        j: "waiting",
      });
    },
  );

  it.each(["a", "b", "f", "j"])("retrying %s reruns both failed branches", (nodeId) => {
    const events = stored([
      ["f", { kind: "sent" }],
      ["a", { kind: "sent" }],
      ["b", { kind: "sent" }],
      ["j", { kind: "running" }],
      failed("a", "no Stop"),
      failed("b", "no Stop"),
      failed("j", "no Stop"),
      failed("f", "no Stop"),
    ]);

    const entries = retryEntries(section(["a", "b"]), events, nodeId);

    expect(sorted(entries)).toEqual(["a retry", "b retry", "f retry", "j retry"]);
    expect(replays(events, entries)).toEqual({
      f: "waiting",
      a: "waiting",
      b: "waiting",
      j: "waiting",
    });
  });

  it("resets a done fork and join and leaves a done branch alone", () => {
    const events = stored([
      ["f", { kind: "sent" }],
      ["a", { kind: "sent" }],
      ["b", { kind: "sent" }],
      ["j", { kind: "running" }],
      ["a", { kind: "done" }],
      ["f", { kind: "done" }],
      ["j", { kind: "done" }],
      failed("b", "no Stop"),
    ]);

    const entries = retryEntries(section(["a", "b"]), events, "b");

    expect(sorted(entries)).toEqual(["b retry", "f retry", "j retry"]);
    expect(replays(events, entries)).toEqual({
      f: "waiting",
      a: "done",
      b: "waiting",
      j: "waiting",
    });
  });

  it("emits nothing for a branch that was never reached", () => {
    const events = stored([
      ["f", { kind: "sent" }],
      ["a", { kind: "sent" }],
      ["j", { kind: "running" }],
      failed("a", "no Stop"),
      failed("j", "no Stop"),
      failed("f", "no Stop"),
    ]);

    const entries = retryEntries(section(["a", "b"]), events, "a");

    expect(sorted(entries)).toEqual(["a retry", "f retry", "j retry"]);
    expect(replays(events, entries).b).toBeUndefined();
  });

  it.each([
    ["sent", [["c", { kind: "sent" }]]],
    [
      "running",
      [
        ["c", { kind: "sent" }],
        ["c", { kind: "needs-you" }],
        ["c", { kind: "running" }],
      ],
    ],
    [
      "needs-you",
      [
        ["c", { kind: "sent" }],
        ["c", { kind: "needs-you" }],
      ],
    ],
  ] as [string, [string, RunEvent][]][])(
    "fails a branch still %s before retrying it",
    (_status, inTurn) => {
      const events = stored([
        ["f", { kind: "sent" }],
        ["a", { kind: "sent" }],
        ["b", { kind: "sent" }],
        ["j", { kind: "running" }],
        ...inTurn,
        ["a", { kind: "done" }],
        failed("b", "no Stop"),
        failed("j", "no Stop"),
        failed("f", "no Stop"),
      ]);

      const entries = retryEntries(section(["a", "b", "c"]), events, "b");

      expect(kinds(entries.filter((entry) => entry.nodeId === "c"))).toEqual([
        "c failed",
        "c retry",
      ]);
      expect(sorted(entries.filter((entry) => entry.nodeId !== "c"))).toEqual([
        "b retry",
        "f retry",
        "j retry",
      ]);
      expect(replays(events, entries)).toEqual({
        f: "waiting",
        a: "done",
        b: "waiting",
        c: "waiting",
        j: "waiting",
      });
    },
  );

  it("fails an in-turn fork before retrying it", () => {
    const events = stored([
      ["f", { kind: "sent" }],
      ["a", { kind: "sent" }],
      ["b", { kind: "sent" }],
      ["j", { kind: "running" }],
      ["a", { kind: "done" }],
      failed("b", "no Stop"),
    ]);

    const entries = retryEntries(section(["a", "b"]), events, "b");

    expect(kinds(entries.filter((entry) => entry.nodeId === "f"))).toEqual(["f failed", "f retry"]);
    expect(kinds(entries.filter((entry) => entry.nodeId === "j"))).toEqual(["j failed", "j retry"]);
    expect(replays(events, entries)).toEqual({
      f: "waiting",
      a: "done",
      b: "waiting",
      j: "waiting",
    });
  });

  it("leaves a skipped branch skipped", () => {
    const events = stored([
      ["f", { kind: "sent" }],
      ["a", { kind: "sent" }],
      ["b", { kind: "sent" }],
      ["c", { kind: "sent" }],
      ["j", { kind: "running" }],
      ["a", { kind: "done" }],
      ["c", { kind: "skipped" }],
      failed("b", "no Stop"),
      failed("j", "no Stop"),
      failed("f", "no Stop"),
    ]);

    const entries = retryEntries(section(["a", "b", "c"]), events, "b");

    expect(sorted(entries)).toEqual(["b retry", "f retry", "j retry"]);
    expect(replays(events, entries)).toEqual({
      f: "waiting",
      a: "done",
      b: "waiting",
      c: "skipped",
      j: "waiting",
    });
  });

  it("still refuses a section node that has not failed", () => {
    expect(() => retryEntries(section(["a", "b"]), oneDoneOneFailed, "a")).toThrow(
      /a has not failed/,
    );
  });
});

describe("resumeEntries", () => {
  it("runs again a script a stop cut short, and touches nothing else", () => {
    const manifest = {
      nodes: [node("s1", "script"), node("s2", "script"), node("p1", "prompt")],
      wires: [],
    };
    const events = stored([
      ["s1", { kind: "running" }],
      ["s1", { kind: "done" }],
      ["s2", { kind: "running" }],
    ]);

    expect(kinds(resumeEntries(manifest, events))).toEqual(["s2 retry"]);
  });
});
