import { describe, expect, it } from "vitest";
import { scopeLine } from "../../../../src/core/compiler/scope-line.js";
import { compileAgent } from "../../../../src/core/nodes/agent/compile.js";
import { bodyOf, frontmatter, sectionOf } from "../../../fixtures/frontmatter.js";

const scope = { build: "fix-login", repo: "carousell-web", workspace: "/fd/workspaces/b1" };
const piece = "review-the-diff";

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

const compiled = (node = agentNode(), more: Partial<Parameters<typeof compileAgent>[1]> = {}) =>
  compileAgent(node, { piece, scope, ...more });

const afterScope = (content: string) => {
  const description = String(frontmatter(content).description);
  expect(description.startsWith(scopeLine(scope))).toBe(true);
  return description.slice(scopeLine(scope).length).trim();
};

const lines = (content: string) => bodyOf(content).split("\n");

describe("compileAgent", () => {
  it("writes plugin/agents/<piece>.md, named by its piece, not its node id", () => {
    expect(compiled().path).toBe("plugin/agents/review-the-diff.md");
  });

  it("names the agent with the bare piece, leaving the plugin prefix to Claude Code", () => {
    expect(frontmatter(compiled().content).name).toBe("review-the-diff");
  });

  it("opens the description with the scope line, followed by the role", () => {
    expect(afterScope(compiled().content)).toBe("Checks the diff");
  });

  it("falls back to the label after the scope line when the role is empty", () => {
    expect(afterScope(compiled(agentNode({ role: "" })).content)).toBe("Review");
  });

  it("keeps a role with YAML-special characters on one quoted line", () => {
    expect(afterScope(compiled(agentNode({ role: 'a: b # "c"\nd' })).content)).toBe(
      'a: b # "c"\nd',
    );
  });

  it("keeps the tools and the model", () => {
    const fields = frontmatter(compiled().content);

    expect(fields.tools).toBe("Read, Grep");
    expect(fields.model).toBe("haiku");
  });

  it("leaves the tools line out when the list is empty and the model line out when it is empty", () => {
    expect(frontmatter(compiled(agentNode({ tools: [] })).content)).not.toHaveProperty("tools");
    expect(frontmatter(compiled(agentNode({ model: "" })).content)).not.toHaveProperty("model");
  });

  it("marks the body as a draft with an @unfilled line", () => {
    expect(lines(compiled().content).some((line) => line.startsWith("@unfilled"))).toBe(true);
  });

  it("lists a file once when the node declares the file its File wire carries", () => {
    const { content } = compiled(agentNode({ writes: ["review.md"], given: ["plan.md"] }), {
      wired: { given: ["plan.md"], writes: ["review.md"] },
    });

    expect(content).toContain("Write: review.md\n");
    expect(content).toContain("You are given: plan.md\n");
  });

  it("lays out the sections Role, Inputs, Steps, Output and When to stop, in that order", () => {
    expect(lines(compiled().content).filter((line) => line.startsWith("## "))).toEqual([
      "## Role",
      "## Inputs",
      "## Steps",
      "## Output",
      "## When to stop",
    ]);
  });

  it("drafts from the instructions, with the build's values filled in", () => {
    const body = bodyOf(
      compiled(agentNode({ instructions: "Review {{ticket}} on {{ base }}." }), {
        values: { ticket: "FD-99", base: "main" },
      }).content,
    );

    expect(body).toContain("Review FD-99 on main.");
    expect(body).not.toContain("{{");
  });

  it("carries the node's hand-off: the files it is given and the files it writes", () => {
    const body = bodyOf(
      compiled(agentNode({ given: ["plan.md", "notes.md"], writes: ["review.md"] })).content,
    );

    expect(body).toContain("You are given: plan.md, notes.md\n");
    expect(body).toContain("Write: review.md\n");
  });

  it("adds the files its wires carry after its own, each file once", () => {
    const body = bodyOf(
      compiled(agentNode({ given: ["plan.md"], writes: ["review.md", "review.md"] }), {
        wired: { given: ["plan.md", "ticket.md"], writes: ["notes.md"] },
      }).content,
    );

    expect(body).toContain("You are given: plan.md, ticket.md\n");
    expect(body).toContain("Write: review.md, notes.md\n");
  });

  it("says under Inputs that hand-off files live in the repo folder inside the workspace", () => {
    expect(sectionOf(compiled().content, /inputs/i)).toContain(
      "Hand-off files are read and written in `carousell-web/`, the run's working folder inside this build's workspace",
    );
  });

  it("names no hand-off side that has no files", () => {
    const body = bodyOf(compiled(agentNode({ given: [], writes: [] })).content);

    expect(body).not.toContain("You are given:");
    expect(body).not.toContain("Write:");
  });
});
