import { describe, expect, it } from "vitest";
import { plainProblems, plainReason, reasonNaming } from "../../../src/core/compiler/problems.js";
import { validate } from "../../../src/core/compiler/validate.js";
import {
  agent,
  flow,
  forEach,
  fork,
  onMainFlow,
  output,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";

describe("plainReason", () => {
  it("drops the node id it starts with and the type tags, and starts with a capital", () => {
    expect(plainReason("foreach-1", "foreach-1 (foreach) has no agent in its body.")).toBe(
      "Has no agent in its body.",
    );
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
      reasonNaming("gate-1", "gate-1 is a parallel branch that is not an Agent.", "Draft"),
    ).toBe("Draft is a parallel branch that is not an Agent.");
  });
});

describe("plainProblems", () => {
  it("lists every problem with its node and field, and no rule ids", () => {
    const current = flow(
      [
        trigger("start"),
        fork("fork-1"),
        agent("agent-1", { settings: { instructions: "" } }),
        forEach("each"),
        output("stop"),
      ],
      [
        thenWire("start", "agent-1"),
        thenWire("agent-1", "each"),
        thenWire("each", "stop"),
        thenWire("each", "fork-1"),
      ],
    );

    const problems = plainProblems(validate(current));

    expect(problems).toEqual([
      { node: "agent-1", field: "instructions", text: "Write what the agent should do." },
      { node: "fork-1", text: "Has 0 branches; a parallel start needs two or more." },
      { node: "each", text: "Has no agent in its body." },
    ]);
    for (const { text } of problems) {
      expect(text).not.toMatch(/required-settings|parallel-section|loop-body/);
    }
  });

  it("keeps a problem with no node, such as the missing repository, and names its container", () => {
    const base = onMainFlow([agent("p")], []);
    const current = {
      ...base,
      containers: base.containers.map((container) =>
        container.kind === "session" ? { ...container, repo: "" } : container,
      ),
    };

    expect(plainProblems(validate(current))).toEqual([
      {
        container: "session-1",
        field: "repo",
        text: 'Session "main" needs a repository. Build is refused until one is set.',
      },
    ]);
  });
});
