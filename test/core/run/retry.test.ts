import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import { resumeEntries, retryEntries } from "../../../src/core/run/retry.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
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

  it.each(["f", "b", "j"])(
    "refuses to retry %s inside a parallel section, leaving its finished branch alone",
    (nodeId) => {
      const manifest = {
        nodes: [node("f", "fork"), node("a", "agent"), node("b", "agent"), node("j", "join")],
        wires: [then("f", "a"), then("f", "b"), then("a", "j"), then("b", "j")],
      };
      const events = stored([
        ["f", { kind: "sent" }],
        ["a", { kind: "sent" }],
        ["b", { kind: "sent" }],
        ["j", { kind: "running" }],
        ["a", { kind: "done" }],
        failed("b", "no Stop"),
        failed("j", "no Stop"),
        failed("f", "no Stop"),
      ]);

      expect(() => retryEntries(manifest, events, nodeId)).toThrow(
        "Retry inside a parallel section isn't supported yet — run it again instead",
      );
    },
  );
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
