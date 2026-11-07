import { describe, expect, it } from "vitest";
import { pieceNames, pieceOf } from "../../../src/core/compiler/pieces.js";
import { agent, flow, prompt, script, thenWire, trigger } from "../../fixtures/flow-builders.js";

const labelled = (make: typeof agent) => (id: string, label: string) => ({ ...make(id), label });

const agentNamed = labelled(agent);
const promptNamed = labelled(prompt);

const namesOf = (nodes: unknown[], wires: unknown[] = []) =>
  Object.fromEntries(pieceNames(flow(nodes, wires)));

describe("pieceNames", () => {
  it("names an Agent or Prompt in kebab case from its label", () => {
    expect(
      namesOf([agentNamed("a", "Sync with base branch"), promptNamed("p", "Write  the PLAN!")]),
    ).toEqual({ a: "sync-with-base-branch", p: "write-the-plan" });
  });

  it("drops letters outside ASCII", () => {
    expect(namesOf([agentNamed("a", "Revisión ✓")])).toEqual({ a: "revisin" });
  });

  it("falls back to the node type when nothing is left of the label", () => {
    expect(namesOf([agentNamed("a", "✓✓"), promptNamed("p", "  ")])).toEqual({
      a: "agent",
      p: "prompt",
    });
  });

  it("cuts a name at 64 characters without a trailing hyphen", () => {
    const label = `${"a".repeat(63)} b${"c".repeat(10)}`;

    expect(namesOf([agentNamed("a", label)])).toEqual({ a: "a".repeat(63) });
    expect(namesOf([agentNamed("a", "x".repeat(70))])).toEqual({ a: "x".repeat(64) });
  });

  it("numbers duplicates in node-array order, whatever the wires say", () => {
    const nodes = [agentNamed("first", "Review"), agentNamed("second", "Review")];

    expect(namesOf(nodes, [thenWire("second", "first")])).toEqual({
      first: "review",
      second: "review-2",
    });
    expect(namesOf([...nodes, agentNamed("third", "review")])).toEqual({
      first: "review",
      second: "review-2",
      third: "review-3",
    });
  });

  it("keeps run for the orchestrator", () => {
    expect(namesOf([agentNamed("a", "Run")])).toEqual({ a: "run-2" });
  });

  it("puts agents and skills in one namespace", () => {
    expect(namesOf([agentNamed("a", "Review"), promptNamed("p", "Review")])).toEqual({
      a: "review",
      p: "review-2",
    });
  });

  it("gives no piece to any other node type", () => {
    expect(namesOf([trigger("t"), script("s"), agentNamed("a", "Build")])).toEqual({
      a: "build",
    });
  });
});

describe("pieceOf", () => {
  it("returns the node's piece, or its id when the build named none", () => {
    expect(pieceOf({ id: "n1", piece: "review-2" })).toBe("review-2");
    expect(pieceOf({ id: "n1" })).toBe("n1");
  });
});
