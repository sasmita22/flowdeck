import { describe, expect, it } from "vitest";
import { plainProblems, plainReason, reasonNaming } from "../../../src/core/compiler/problems.js";
import { validate } from "../../../src/core/compiler/validate.js";
import { agent, flow, forEach, fork, prompt } from "../../fixtures/flow-builders.js";

describe("plainReason", () => {
  it("drops the node id it starts with and the type tags, and starts with a capital", () => {
    expect(
      plainReason("foreach-1", "foreach-1 (foreach) has no prompt or agent in its body."),
    ).toBe("Has no prompt or agent in its body.");
  });

  it("keeps a message that does not start with the node id", () => {
    expect(plainReason("agent-1", "Write what the agent should do.")).toBe(
      "Write what the agent should do.",
    );
  });
});

describe("reasonNaming", () => {
  it("puts the node's label where its id started the message", () => {
    expect(
      reasonNaming("prompt-1", "prompt-1 is a parallel branch that is not an Agent.", "Draft"),
    ).toBe("Draft is a parallel branch that is not an Agent.");
  });
});

describe("plainProblems", () => {
  it("lists every problem with its node and field, and no rule ids", () => {
    const current = flow(
      [fork("fork-1"), agent("agent-1", { settings: { instructions: "" } }), forEach("each")],
      [],
    );

    const problems = plainProblems(validate(current));

    expect(problems).toEqual([
      { node: "agent-1", field: "instructions", text: "Write what the agent should do." },
      { node: "fork-1", text: "Has 0 branches; a parallel start needs two or more." },
      { node: "each", text: "Has no prompt or agent in its body." },
    ]);
    for (const { text } of problems) {
      expect(text).not.toMatch(/required-settings|parallel-section|loop-body/);
    }
  });

  it("keeps a problem with no node, such as the session folder", () => {
    const base = flow([prompt("p")], []);
    const current = {
      ...base,
      session: { ...base.session, workingFolder: { kind: "path" as const, path: "" } },
    };

    expect(plainProblems(validate(current))).toEqual([
      {
        field: "workingFolder.path",
        text: "Choose the folder this blueprint works in, in the session settings.",
      },
    ]);
  });
});
