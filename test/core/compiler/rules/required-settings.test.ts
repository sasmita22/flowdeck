import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/required-settings.js";
import { agent, ask, flow, hardstop, loop } from "../../../fixtures/flow-builders.js";

const errorsFor = (node: unknown) =>
  rule.check(flow([node], [])).map(({ rule, node, field }) => ({ rule, node, field }));

const messageFor = (node: unknown) => rule.check(flow([node], []))[0]?.message;

describe("required-settings", () => {
  it.each([
    ["agent", agent, "instructions"],
    ["loop", loop, "condition"],
    ["ask", ask, "question"],
  ] as const)("reports a %s whose %s is blank", (_type, make, field) => {
    for (const blank of ["", "  \n\t"]) {
      expect(errorsFor(make("N", { settings: { [field]: blank } }))).toEqual([
        { rule: "required-settings", node: "N", field },
      ]);
    }
  });

  it.each([
    ["agent", agent, "instructions"],
    ["loop", loop, "condition"],
    ["ask", ask, "question"],
  ] as const)("accepts a %s whose %s is written", (_type, make, field) => {
    expect(errorsFor(make("N", { settings: { [field]: "Written." } }))).toEqual([]);
  });

  it("reports an agent still holding the old placeholder task", () => {
    expect(
      errorsFor(agent("A", { settings: { instructions: " Describe the agent's task. " } })),
    ).toEqual([{ rule: "required-settings", node: "A", field: "instructions" }]);
  });

  it("says what to write in plain words, without the node id", () => {
    expect(messageFor(agent("A", { settings: { instructions: "" } }))).toBe(
      "Write what the agent should do.",
    );
    expect(messageFor(loop("L", { settings: { condition: "" } }))).toBe(
      "Write when the loop is done.",
    );
    expect(messageFor(ask("Q", { settings: { question: "" } }))).toBe("Write the question to ask.");
  });

  it("names only Agents, Loops and Asks in its rule message", () => {
    expect(rule.message).toBe("Agents need instructions, Loops a condition and Asks a question.");
  });

  it("lets a hard stop with no condition through, because it asks directly", () => {
    expect(errorsFor(hardstop("H", { settings: { condition: "" } }))).toEqual([]);
  });
});
