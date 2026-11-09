import { describe, expect, it } from "vitest";
import { mainFlow, mainFlowOnly } from "../../../src/core/flow/main-flow.js";
import {
  fileWire,
  flow,
  forEach,
  loop,
  output,
  prompt,
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
        [trigger("start"), prompt("b"), prompt("a"), prompt("c"), output("stop"), prompt("d")],
        [thenWire("start", "a"), thenWire("a", "stop"), thenWire("c", "d")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["b", "c", "d"]);
  });

  it("is undefined without a Start", () => {
    expect(mainFlow(flow([prompt("a"), output("stop")], [thenWire("a", "stop")]))).toBeUndefined();
  });

  it("is undefined with two wired Starts", () => {
    const twoStarts = flow(
      [trigger("one"), trigger("two"), prompt("a"), output("stop")],
      [thenWire("one", "a"), thenWire("two", "a"), thenWire("a", "stop")],
    );

    expect(mainFlow(twoStarts)).toBeUndefined();
  });

  it("is undefined with a second, loose Start", () => {
    const twoStarts = flow(
      [trigger("one"), trigger("two"), prompt("a"), output("stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
    );

    expect(mainFlow(twoStarts)).toBeUndefined();
  });

  it("reaches a Loop frame through a wire into its body", () => {
    const found = mainFlow(
      flow(
        [
          trigger("start"),
          prompt("a"),
          loop("l"),
          prompt("x", { parent: "l" }),
          prompt("y", { parent: "l" }),
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
          prompt("x", { parent: "l" }),
          prompt("y", { parent: "l" }),
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
          prompt("ox", { parent: "outer" }),
          loop("inner", { parent: "outer" }),
          prompt("ix", { parent: "inner" }),
          prompt("iy", { parent: "inner" }),
          output("stop"),
          prompt("loose"),
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
        [trigger("start"), forEach("each"), prompt("p", { parent: "each" }), output("stop")],
        [thenWire("start", "each"), thenWire("each", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["each", "p", "start", "stop"]);
  });

  it("follows File wires but not event wires", () => {
    const found = mainFlow(
      flow(
        [trigger("start"), prompt("a"), prompt("b"), prompt("c"), output("stop")],
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
      [trigger("start"), prompt("a"), prompt("b"), prompt("c"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("b", "stop"), thenWire("b", "c")],
    );

    const only = mainFlowOnly(input);

    expect(only.nodes.map((node) => node.id)).toEqual(["start", "a", "stop"]);
    expect(only.wires).toEqual([thenWire("start", "a"), thenWire("a", "stop")]);
    expect(only.session).toEqual(input.session);
  });

  it("returns the flow unchanged without a Start", () => {
    const input = flow([prompt("a"), prompt("b"), output("stop")], [thenWire("a", "stop")]);

    expect(mainFlowOnly(input)).toEqual(input);
  });

  it("returns the flow unchanged with two Starts", () => {
    const input = flow(
      [trigger("one"), trigger("two"), prompt("a"), prompt("b"), output("stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
    );

    expect(mainFlowOnly(input)).toEqual(input);
  });
});
