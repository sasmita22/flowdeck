import { describe, expect, it } from "vitest";
import { mainFlow, mainFlowOnly } from "../../../src/core/flow/main-flow.js";
import {
  agent,
  fileWire,
  flow,
  forEach,
  loop,
  output,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";

const eventWire = (from: string, to: string) => ({
  kind: "event",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const reachedIds = (found: ReturnType<typeof mainFlow>) => [...(found?.reached ?? [])].sort();

describe("mainFlow", () => {
  it("reaches what Start leads to and ignores the rest in node order", () => {
    const found = mainFlow(
      flow(
        [trigger("start"), agent("b"), agent("a"), agent("c"), output("stop"), agent("d")],
        [thenWire("start", "a"), thenWire("a", "stop"), thenWire("c", "d")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["b", "c", "d"]);
  });

  it("is undefined without a Start", () => {
    expect(mainFlow(flow([agent("a"), output("stop")], [thenWire("a", "stop")]))).toBeUndefined();
  });

  it("is undefined with two wired Starts", () => {
    const twoStarts = flow(
      [trigger("one"), trigger("two"), agent("a"), output("stop")],
      [thenWire("one", "a"), thenWire("two", "a"), thenWire("a", "stop")],
    );

    expect(mainFlow(twoStarts)).toBeUndefined();
  });

  it("is undefined with a second, loose Start", () => {
    const twoStarts = flow(
      [trigger("one"), trigger("two"), agent("a"), output("stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
    );

    expect(mainFlow(twoStarts)).toBeUndefined();
  });

  it("reaches a Loop frame through a wire into its body", () => {
    const found = mainFlow(
      flow(
        [
          trigger("start"),
          agent("a"),
          loop("l"),
          agent("x", { parent: "l" }),
          agent("y", { parent: "l" }),
          output("stop"),
        ],
        [thenWire("start", "a"), thenWire("a", "x"), thenWire("x", "y"), thenWire("y", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "l", "start", "stop", "x", "y"]);
    expect(found?.ignored).toEqual([]);
  });

  it("reaches every body node through a wire into the frame", () => {
    const found = mainFlow(
      flow(
        [
          trigger("start"),
          loop("l"),
          agent("x", { parent: "l" }),
          agent("y", { parent: "l" }),
          output("stop"),
        ],
        [thenWire("start", "l"), thenWire("x", "y"), thenWire("l", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["l", "start", "stop", "x", "y"]);
  });

  it("reaches both nested frames and both bodies from an inner body node", () => {
    const found = mainFlow(
      flow(
        [
          trigger("start"),
          loop("outer"),
          agent("ox", { parent: "outer" }),
          loop("inner", { parent: "outer" }),
          agent("ix", { parent: "inner" }),
          agent("iy", { parent: "inner" }),
          output("stop"),
          agent("loose"),
        ],
        [thenWire("start", "ix"), thenWire("ix", "iy"), thenWire("outer", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["inner", "ix", "iy", "outer", "ox", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["loose"]);
  });

  it("keeps the body of a For each frame on the main flow", () => {
    const found = mainFlow(
      flow(
        [trigger("start"), forEach("each"), agent("p", { parent: "each" }), output("stop")],
        [thenWire("start", "each"), thenWire("each", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["each", "p", "start", "stop"]);
  });

  it("follows File wires but not event wires", () => {
    const found = mainFlow(
      flow(
        [trigger("start"), agent("a"), agent("b"), agent("c"), output("stop")],
        [
          thenWire("start", "a"),
          fileWire("a", "b", "notes.md"),
          eventWire("a", "c"),
          thenWire("b", "stop"),
        ],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "b", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["c"]);
  });
});

describe("mainFlowOnly", () => {
  it("drops ignored nodes and every wire with an ignored end", () => {
    const input = flow(
      [trigger("start"), agent("a"), agent("b"), agent("c"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("b", "stop"), thenWire("b", "c")],
    );

    const only = mainFlowOnly(input);

    expect(only.nodes.map((node) => node.id)).toEqual(["start", "a", "stop"]);
    expect(only.wires).toEqual([thenWire("start", "a"), thenWire("a", "stop")]);
    expect(only.session).toEqual(input.session);
  });

  it("returns the flow unchanged without a Start", () => {
    const input = flow([agent("a"), agent("b"), output("stop")], [thenWire("a", "stop")]);

    expect(mainFlowOnly(input)).toEqual(input);
  });

  it("returns the flow unchanged with two Starts", () => {
    const input = flow(
      [trigger("one"), trigger("two"), agent("a"), agent("b"), output("stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
    );

    expect(mainFlowOnly(input)).toEqual(input);
  });
});
