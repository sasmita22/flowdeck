import { describe, expect, it } from "vitest";
import { compileAgent } from "../../../../src/core/nodes/agent/compile.js";

const agentNode = (
  settings: Partial<{ role: string; instructions: string; model: string; tools: string[] }> = {},
) => ({
  id: "reviewer",
  type: "agent" as const,
  label: "Review",
  position: { x: 0, y: 0 },
  settings: {
    role: "Checks the diff",
    instructions: "Review it.",
    model: "haiku",
    tools: ["Read", "Grep"],
    ...settings,
  },
});

describe("compileAgent", () => {
  it("writes an agent file with name, description, tools and model", () => {
    expect(compileAgent(agentNode())).toEqual({
      path: "agents/reviewer.md",
      content:
        '---\nname: "reviewer"\ndescription: "Checks the diff"\ntools: "Read, Grep"\nmodel: "haiku"\n---\nReview it.\n',
    });
  });

  it("leaves the tools line out when the list is empty", () => {
    expect(compileAgent(agentNode({ tools: [] })).content).toBe(
      '---\nname: "reviewer"\ndescription: "Checks the diff"\nmodel: "haiku"\n---\nReview it.\n',
    );
  });

  it("falls back to the label when the role is empty", () => {
    expect(compileAgent(agentNode({ role: "" })).content).toBe(
      '---\nname: "reviewer"\ndescription: "Review"\ntools: "Read, Grep"\nmodel: "haiku"\n---\nReview it.\n',
    );
  });

  it("leaves the model line out when the model is empty", () => {
    expect(compileAgent(agentNode({ model: "" })).content).toBe(
      '---\nname: "reviewer"\ndescription: "Checks the diff"\ntools: "Read, Grep"\n---\nReview it.\n',
    );
  });

  it("keeps a role with YAML-special characters on one quoted line", () => {
    expect(compileAgent(agentNode({ role: 'a: b # "c"\nd' })).content).toBe(
      '---\nname: "reviewer"\ndescription: "a: b # \\"c\\"\\nd"\ntools: "Read, Grep"\nmodel: "haiku"\n---\nReview it.\n',
    );
  });
});
