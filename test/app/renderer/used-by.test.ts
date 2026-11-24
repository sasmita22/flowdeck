import { describe, expect, it } from "vitest";
import { libraryUsers, openUserFromDelete } from "../../../src/app/renderer/used-by.js";
import type { FlowSummary } from "../../../src/core/flow/flow-store.js";
import { flowSummary as summary } from "../../fixtures/flow-summary.js";

const ids = (summaries: readonly FlowSummary[] | null) =>
  summaries === null ? null : summaries.map((found) => found.flowId);

const summaries = [
  summary("w1", "workflow", ["a", "s"]),
  summary("a", "node-library", ["b"]),
  summary("b", "node-library", []),
  summary("s", "session-library", []),
  summary("i", "incomplete", []),
];

describe("libraryUsers", () => {
  it("lists who uses a node library or a session library", () => {
    expect(ids(libraryUsers(summaries, "b"))).toEqual(["w1", "a"]);
    expect(ids(libraryUsers(summaries, "s"))).toEqual(["w1"]);
  });

  it("gives an empty list for a library nothing uses", () => {
    expect(libraryUsers([summary("b", "node-library", [])], "b")).toEqual([]);
  });

  it("has no list for a workflow, an incomplete blueprint or an unknown id", () => {
    expect(libraryUsers(summaries, "w1")).toBeNull();
    expect(libraryUsers(summaries, "i")).toBeNull();
    expect(libraryUsers(summaries, "gone")).toBeNull();
    expect(libraryUsers(summaries, undefined)).toBeNull();
  });
});

describe("openUserFromDelete", () => {
  it("cancels the delete before opening the blueprint that uses the library", () => {
    const calls: string[] = [];
    const open = openUserFromDelete(
      { cancelDelete: () => calls.push("cancel") },
      {
        openBlueprint: async (flowId) => {
          calls.push(`open ${flowId}`);
        },
      },
    );

    open("w1");

    expect(calls).toEqual(["cancel", "open w1"]);
  });
});
