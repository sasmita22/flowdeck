import { describe, expect, it } from "vitest";
import { compileAgent } from "../../../../src/core/nodes/agent/compile.js";

const agentNode = (
  settings: Partial<{
    role: string;
    instructions: string;
    model: string;
    tools: string[];
    given: string[];
    writes: string[];
  }> = {},
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

  it("ends the agent file with the files it is given and the files it writes", () => {
    const { content } = compileAgent(
      agentNode({ given: ["plan.md", "notes.md"], writes: ["review.md"] }),
    );

    expect(content).toMatch(
      /---\nReview it\.\n\nYou are given: plan\.md, notes\.md\nWrite: review\.md\n$/,
    );
  });

  it("adds the files its wires carry after its own, leaving its own entries as they are", () => {
    const { content } = compileAgent(agentNode({ given: ["plan.md"], writes: ["review.md"] }), {
      given: ["plan.md", "ticket.md"],
      writes: ["notes.md"],
    });

    expect(content).toMatch(
      /---\nReview it\.\n\nYou are given: plan\.md, plan\.md, ticket\.md\nWrite: review\.md, notes\.md\n$/,
    );
  });

  it("keeps repeated entries of its own exactly as before File wires", () => {
    const { content } = compileAgent(
      agentNode({ given: ["plan.md", "plan.md"], writes: ["review.md", "review.md"] }),
    );

    expect(content).toBe(
      '---\nname: "reviewer"\ndescription: "Checks the diff"\ntools: "Read, Grep"\nmodel: "haiku"\n---\nReview it.\n\nYou are given: plan.md, plan.md\nWrite: review.md, review.md\n',
    );
  });

  it("names only the side that has files, and nothing for empty lists", () => {
    expect(compileAgent(agentNode({ writes: ["review.md"] })).content).toMatch(
      /---\nReview it\.\n\nWrite: review\.md\n$/,
    );
    expect(compileAgent(agentNode({ given: [], writes: [] })).content).toMatch(
      /---\nReview it\.\n$/,
    );
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
