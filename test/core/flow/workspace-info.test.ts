import { describe, expect, it } from "vitest";
import { folderStateSchema, type FolderState } from "../../../src/core/flow/workspace-info.js";

describe("folderStateSchema", () => {
  it.each<FolderState>([
    { kind: "branch", name: "main" },
    { kind: "detached", commit: "abc1234" },
    { kind: "not-a-repo" },
    { kind: "missing" },
  ])("accepts $kind", (state) => {
    expect(folderStateSchema.parse(state)).toEqual(state);
  });

  it("refuses a branch without a name", () => {
    expect(folderStateSchema.safeParse({ kind: "branch" }).success).toBe(false);
  });
});
