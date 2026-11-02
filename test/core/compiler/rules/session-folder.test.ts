import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/session-folder.js";
import type { Session } from "../../../../src/core/flow/schema.js";
import { flow, prompt } from "../../../fixtures/flow-builders.js";

const inFolder = (workingFolder: Session["workingFolder"]) => {
  const base = flow([prompt("p")], []);
  return { ...base, session: { ...base.session, workingFolder } };
};

describe("session-folder", () => {
  it.each(["", "   "])("asks for the folder when its path is %j", (path) => {
    expect(rule.check(inFolder({ kind: "path", path }))).toEqual([
      {
        rule: "session-folder",
        field: "workingFolder.path",
        message: "Choose the folder this blueprint works in, in the session settings.",
      },
    ]);
  });

  it("accepts a folder path", () => {
    expect(rule.check(inFolder({ kind: "path", path: "/work/repo" }))).toEqual([]);
  });

  it("leaves a new worktree to the run, which names a missing repository itself", () => {
    expect(rule.check(inFolder({ kind: "worktree", branch: "main" }))).toEqual([]);
  });
});
