import { describe, expect, it } from "vitest";
import { coveredOnEveryPath, reachableFrom } from "../../../src/core/flow/paths.js";
import {
  agent,
  branch,
  forEach,
  loop,
  onMainFlow,
  thenWire,
  wire,
} from "../../fixtures/flow-builders.js";
import type { Flow } from "../../../src/core/flow/schema.js";

const after = (flow: Flow, nodeId: string) =>
  [...reachableFrom(flow, nodeId)].filter((id) => id !== nodeId).sort();

const twoArms = (yesArm: string[], noArm: string[]) =>
  onMainFlow(
    [branch("br", "e2e"), ...[...yesArm, ...noArm, "r"].map((id) => agent(id))],
    [
      wire("br", "yes", yesArm[0] ?? "r", "in"),
      ...yesArm.map((id, index) => thenWire(id, yesArm[index + 1] ?? "r")),
      wire("br", "no", noArm[0] ?? "r", "in"),
      ...noArm.map((id, index) => thenWire(id, noArm[index + 1] ?? "r")),
    ],
  );

const loopBody = onMainFlow(
  [loop("L"), agent("w", { parent: "L" }), agent("r", { parent: "L" })],
  [thenWire("w", "r")],
);

describe("reachableFrom", () => {
  it("follows Then wires", () => {
    const flow = onMainFlow(
      [agent("a"), agent("b"), agent("c")],
      [thenWire("a", "b"), thenWire("b", "c")],
    );

    expect(after(flow, "a")).toEqual(["b", "c", "stop"]);
    expect(after(flow, "b")).toEqual(["c", "stop"]);
  });

  it("follows both Branch arms", () => {
    expect(after(twoArms(["y"], ["n"]), "br")).toEqual(["n", "r", "stop", "y"]);
  });

  it("enters a Loop body and leaves through the frame, not back to an earlier body node", () => {
    expect(after(loopBody, "start")).toEqual(["L", "r", "stop", "w"]);
    expect(after(loopBody, "r")).toEqual(["stop"]);
  });

  it("enters a For each body", () => {
    const flow = onMainFlow([forEach("each"), agent("p", { parent: "each" })], []);

    expect(after(flow, "start")).toEqual(["each", "p", "stop"]);
  });
});

describe("coveredOnEveryPath", () => {
  it("is true when a source sits on the only path", () => {
    const flow = onMainFlow([agent("w"), agent("r")], [thenWire("w", "r")]);

    expect(coveredOnEveryPath(flow, "r", ["w"])).toBe(true);
  });

  it("is false when one Branch arm skips the source", () => {
    expect(coveredOnEveryPath(twoArms(["w"], []), "r", ["w"])).toBe(false);
  });

  it("is true when both Branch arms carry a source", () => {
    expect(coveredOnEveryPath(twoArms(["w1"], ["w2"]), "r", ["w1", "w2"])).toBe(true);
  });

  it("is false when the source runs after the target", () => {
    const flow = onMainFlow([agent("r"), agent("w")], [thenWire("r", "w")]);

    expect(coveredOnEveryPath(flow, "r", ["w"])).toBe(false);
  });

  it("is true for a source earlier in the same Loop body", () => {
    expect(coveredOnEveryPath(loopBody, "r", ["w"])).toBe(true);
  });
});
