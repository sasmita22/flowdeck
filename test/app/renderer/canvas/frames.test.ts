import { describe, expect, it } from "vitest";
import {
  bodyFrameBounds,
  boundsOf,
  centerOf,
  containerLabelWidth,
  containerText,
  FRAME_PADDING,
  nodeWidth,
  textWidth,
} from "../../../../src/app/renderer/canvas/frames.js";
import { nodeLook, tagWidth } from "../../../../src/app/renderer/nodes/look.js";
import { nodeOutline } from "../../../../src/app/renderer/nodes/outlines.js";
import { agent, flow, loop } from "../../../fixtures/flow-builders.js";

const long = "Review every changed file against the plan and list each gap";

describe("nodeWidth", () => {
  it("keeps a short-label node at its type's base width", () => {
    expect(nodeWidth({ type: "agent", label: "agent" })).toBe(170);
    expect(nodeWidth({ type: "branch", label: "E2E?", sub: "x" })).toBe(116);
    expect(nodeWidth({ type: "fork", label: "fork" })).toBe(28);
    expect(nodeWidth({ type: "join", label: "join" })).toBe(28);
  });

  it.each(["trigger", "output"] as const)(
    "keeps a %s at its 48 px circle whatever the label length",
    (type) => {
      expect(nodeWidth({ type, label: "S" })).toBe(48);
      expect(nodeWidth({ type, label: long })).toBe(48);
    },
  );

  it("widens an Agent to fit a 60-character label", () => {
    expect(long).toHaveLength(60);
    expect(nodeWidth({ type: "agent", label: long })).toBe(textWidth("agent", long));
    expect(textWidth("agent", long)).toBeGreaterThan(170);
  });

  it("widens a Script by the 12px mono character width after its tag", () => {
    const { padL } = nodeOutline("script");
    expect(nodeWidth({ type: "script", label: long })).toBeCloseTo(
      padL + tagWidth("SH") + 6 + 60 * 7.2 + padL,
    );
  });

  it("takes the width from a sub-line longer than the label", () => {
    expect(nodeWidth({ type: "branch", label: "E2E?", sub: long })).toBe(textWidth("branch", long));
    expect(textWidth("branch", long)).toBeGreaterThan(textWidth("branch", "E2E?"));
  });

  it.each(["loop", "foreach"] as const)("sizes a %s as its container label does today", (type) => {
    const sub = type === "loop" ? "max 3" : "plan.md";
    expect(nodeWidth({ type, label: long, sub })).toBe(
      containerLabelWidth(type, containerText(type, long, sub)),
    );
  });

  it("estimates a Loop title at 7 px a character when nothing can measure it", () => {
    const text = containerText("loop", long, "max 3");
    expect(nodeWidth({ type: "loop", label: long, sub: "max 3" })).toBe(
      text.length * 7 + 2 * nodeOutline("loop").padL,
    );
  });
});

describe("frame geometry of a wide node", () => {
  const wide = flow(
    [
      { ...loop("L"), position: { x: 40, y: 40 } },
      { ...agent("A", { parent: "L" }), label: long, position: { x: 40, y: 130 } },
    ],
    [],
  );
  const wideAgent = wide.nodes.find((node) => node.id === "A");
  const theLoop = wide.nodes.find((node) => node.id === "L");
  if (wideAgent === undefined || theLoop === undefined) throw new Error("expected L and A");
  const width = () => nodeWidth({ type: "agent", label: long });

  it("bounds a wide node by its width", () => {
    expect(boundsOf(wideAgent).right).toBe(40 + width());
  });

  it("centres a wide node on its width", () => {
    expect(centerOf(wideAgent)).toEqual({
      x: 40 + width() / 2,
      y: 130 + nodeLook("agent").box.height / 2,
    });
  });

  it("reaches a Loop's frame past its wide body node by the frame padding", () => {
    expect(bodyFrameBounds(wide, theLoop).right).toBe(40 + width() + FRAME_PADDING);
  });
});
