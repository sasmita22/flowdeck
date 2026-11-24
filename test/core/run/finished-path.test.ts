import { describe, expect, it } from "vitest";
import { hasFinishedPath } from "../../../src/core/run/finished-path.js";

type Kind = "trigger" | "output" | "agent" | "branch" | "fork" | "join" | "loop" | "foreach";

const node = (id: string, type: Kind, parent?: string) => ({
  id,
  type,
  label: id,
  ...(parent === undefined ? {} : { parent }),
});

const then = (from: string, to: string, port = "out") => ({
  kind: "then" as const,
  from: { node: from, port },
  to: { node: to, port: "in" },
});

const event = (from: string, to: string) => ({
  kind: "event" as const,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const ends = [node("start", "trigger"), node("stop", "output")];

const passes = (
  nodes: ReturnType<typeof node>[],
  wires: (ReturnType<typeof then> | ReturnType<typeof event>)[],
  ...finished: string[]
) => hasFinishedPath({ nodes: [...ends, ...nodes], wires }, new Set(finished));

describe("hasFinishedPath", () => {
  describe("a straight line of Agents", () => {
    const nodes = [node("a1", "agent"), node("a2", "agent")];
    const wires = [then("start", "a1"), then("a1", "a2"), then("a2", "stop")];

    it.each([
      { finished: [], expected: false },
      { finished: ["a1"], expected: false },
      { finished: ["a2"], expected: false },
      { finished: ["a1", "a2"], expected: true },
    ])("with $finished finished is $expected", ({ finished, expected }) => {
      expect(passes(nodes, wires, ...finished)).toBe(expected);
    });
  });

  it("passes a Start wired straight to its Stop", () => {
    expect(passes([], [then("start", "stop")])).toBe(true);
  });

  describe("a branch with an Agent on each side", () => {
    const nodes = [node("ask", "branch"), node("yes", "agent"), node("no", "agent")];
    const wires = [
      then("start", "ask"),
      then("ask", "yes", "yes"),
      then("ask", "no", "no"),
      then("yes", "stop"),
      then("no", "stop"),
    ];

    it("passes once one side's Agent is finished", () => {
      expect(passes(nodes, wires, "no")).toBe(true);
    });

    it("does not pass with neither side finished", () => {
      expect(passes(nodes, wires)).toBe(false);
    });
  });

  it("passes a branch whose other side reaches Stop with no Agent", () => {
    const nodes = [node("ask", "branch"), node("yes", "agent")];
    const wires = [
      then("start", "ask"),
      then("ask", "yes", "yes"),
      then("ask", "stop", "no"),
      then("yes", "stop"),
    ];

    expect(passes(nodes, wires)).toBe(true);
  });

  it("does not follow an event wire to Stop", () => {
    const nodes = [node("a1", "agent"), node("a2", "agent")];
    const wires = [then("start", "a1"), then("a1", "a2"), event("a1", "stop")];

    expect(passes(nodes, wires, "a1")).toBe(false);
  });

  it("does not pass when no then-wire route leads from Start to Stop", () => {
    expect(passes([node("a1", "agent")], [then("start", "a1")], "a1")).toBe(false);
  });

  describe("a Loop on the path", () => {
    describe("with an unwired body", () => {
      const nodes = [node("l", "loop"), node("la", "agent", "l"), node("lb", "agent", "l")];
      const wires = [then("start", "l"), then("l", "stop")];

      it("does not pass with one body Agent finished", () => {
        expect(passes(nodes, wires, "la")).toBe(false);
      });

      it("passes with every body Agent finished", () => {
        expect(passes(nodes, wires, "la", "lb")).toBe(true);
      });
    });

    describe("with a body entered from the frame and wired back on itself", () => {
      const nodes = [node("l", "loop"), node("la", "agent", "l"), node("lb", "agent", "l")];
      const wires = [
        then("start", "l"),
        then("l", "la"),
        then("la", "lb"),
        then("lb", "la"),
        then("l", "stop"),
      ];

      it("passes with both body Agents finished", () => {
        expect(passes(nodes, wires, "la", "lb")).toBe(true);
      });

      it("does not pass with only the first body Agent finished", () => {
        expect(passes(nodes, wires, "la")).toBe(false);
      });
    });

    describe("with a wired body no wire enters", () => {
      const nodes = [node("l", "loop"), node("la", "agent", "l"), node("lb", "agent", "l")];
      const wires = [then("start", "l"), then("la", "lb"), then("l", "stop")];

      it("passes with both body Agents finished", () => {
        expect(passes(nodes, wires, "la", "lb")).toBe(true);
      });

      it("does not pass with only the first body Agent finished", () => {
        expect(passes(nodes, wires, "la")).toBe(false);
      });
    });

    describe("entered and left through its body nodes", () => {
      const nodes = [node("l", "loop"), node("la", "agent", "l"), node("lb", "agent", "l")];
      const wires = [then("start", "la"), then("lb", "stop")];

      it("passes with every body Agent finished", () => {
        expect(passes(nodes, wires, "la", "lb")).toBe(true);
      });

      it("does not pass with a body Agent unfinished", () => {
        expect(passes(nodes, wires, "la")).toBe(false);
      });
    });
  });

  it("passes a For each whose body Agent never ran", () => {
    const nodes = [node("f", "foreach"), node("fa", "agent", "f")];
    const wires = [then("start", "f"), then("f", "fa"), then("f", "stop")];

    expect(passes(nodes, wires)).toBe(true);
  });

  it("passes a fork once one of its joined Agents is finished", () => {
    const nodes = [
      node("split", "fork"),
      node("x", "agent"),
      node("y", "agent"),
      node("merge", "join"),
    ];
    const wires = [
      then("start", "split"),
      then("split", "x"),
      then("split", "y"),
      then("x", "merge"),
      then("y", "merge"),
      then("merge", "stop"),
    ];

    expect(passes(nodes, wires, "x")).toBe(true);
  });
});
