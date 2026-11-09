import { describe, expect, it } from "vitest";
import { mainFlow } from "../../src/core/flow/main-flow.js";
import { loop, onMainFlow, output, prompt, thenWire, trigger } from "./flow-builders.js";

const reachedIds = (found: ReturnType<typeof mainFlow>) => [...(found?.reached ?? [])].sort();

describe("onMainFlow", () => {
  it("wires Start into the chain and the chain into Stop", () => {
    const result = onMainFlow([prompt("a"), prompt("b")], [thenWire("a", "b")]);

    expect(result.nodes.find((node) => node.id === "start")?.type).toBe("trigger");
    expect(result.nodes.find((node) => node.id === "stop")?.type).toBe("output");
    expect(result.wires).toEqual(
      expect.arrayContaining([thenWire("start", "a"), thenWire("b", "stop")]),
    );
    expect(mainFlow(result)?.ignored).toEqual([]);
  });

  it("reaches a loose node next to a chain", () => {
    const result = onMainFlow([prompt("a"), prompt("b"), prompt("c")], [thenWire("a", "b")]);

    expect(reachedIds(mainFlow(result))).toEqual(["a", "b", "c", "start", "stop"]);
  });

  it("reaches a Loop through its body wires without wiring the frame", () => {
    const result = onMainFlow(
      [
        prompt("a"),
        loop("l"),
        prompt("x", { parent: "l" }),
        prompt("y", { parent: "l" }),
        prompt("b"),
      ],
      [thenWire("a", "x"), thenWire("x", "y"), thenWire("y", "b")],
    );

    expect(reachedIds(mainFlow(result))).toEqual(["a", "b", "l", "start", "stop", "x", "y"]);
    expect(result.wires.filter((wire) => wire.from.node === "l" || wire.to.node === "l")).toEqual(
      [],
    );
  });

  it.each([
    ["an id start", [prompt("start")]],
    ["an id stop", [prompt("stop")]],
    ["a trigger", [trigger("go")]],
    ["an output", [output("done")]],
  ])("throws on input holding %s", (_, nodes) => {
    expect(() => onMainFlow(nodes, [])).toThrow();
  });
});
