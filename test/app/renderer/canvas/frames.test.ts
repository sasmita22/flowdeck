import { describe, expect, it } from "vitest";
import {
  bodyFrameBounds,
  boundsOf,
  centerOf,
  containerLabelWidth,
  containerText,
  flowContainerAt,
  flowContainerBounds,
  FRAME_PADDING,
  nodeWidth,
  padded,
  sideLabelSpan,
  textWidth,
  type Bounds,
} from "../../../../src/app/renderer/canvas/frames.js";
import { nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import { nodeOutline } from "../../../../src/app/renderer/nodes/outlines.js";
import type { Flow } from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  loop,
  output,
  sessionContainer,
  trigger,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";

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

  it("takes the width from a sub-line longer than the label", () => {
    expect(nodeWidth({ type: "branch", label: "E2E?", sub: long })).toBe(textWidth("branch", long));
    expect(textWidth("branch", long)).toBeGreaterThan(textWidth("branch", "E2E?"));
  });

  it.each(["loop"] as const)("sizes a %s as its container label does today", (type) => {
    const sub = "max 3";
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

describe("flow container frames", () => {
  const placed = <N extends object>(node: N, x: number, y: number) => ({
    ...node,
    position: { x, y },
  });

  const framed = (): Flow =>
    flow(
      [
        placed(trigger("w-start"), 0, 0),
        placed(output("w-stop"), 300, 0),
        placed(trigger("s"), 0, 400),
        placed(agent("A"), 200, 420),
        placed(loop("L"), 600, 400),
        placed(agent("P", { parent: "L" }), 600, 500),
        placed(output("t"), 1000, 400),
      ],
      [],
      flowSettings,
      {
        containers: [
          workspaceContainer(["w-start", "w-stop"]),
          sessionContainer(["s", "A", "L", "t"]),
        ],
      },
    );

  const node = (source: Flow, id: string) => {
    const found = source.nodes.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no node ${id}`);
    return found;
  };

  const labelled = (source: Flow, id: string): Bounds => {
    const bounds = boundsOf(node(source, id));
    return { ...bounds, right: bounds.right + sideLabelSpan(node(source, id).label) };
  };

  it("fits a container round its members with the Loop frame's padding", () => {
    const source = framed();

    expect(flowContainerBounds(source, "workspace-1")).toEqual(
      padded([labelled(source, "w-start"), labelled(source, "w-stop")]),
    );
  });

  it("fits a container round a member Loop's whole frame, body included", () => {
    const source = framed();

    expect(flowContainerBounds(source, "session-1")).toEqual(
      padded([
        labelled(source, "s"),
        boundsOf(node(source, "A")),
        bodyFrameBounds(source, node(source, "L")),
        labelled(source, "t"),
      ]),
    );
  });

  it("follows a member when it moves", () => {
    const source = framed();
    const moved: Flow = {
      ...source,
      nodes: source.nodes.map((candidate) =>
        candidate.id === "w-stop" ? { ...candidate, position: { x: 900, y: 0 } } : candidate,
      ),
    };

    expect(flowContainerBounds(moved, "workspace-1").right).toBe(
      labelled(moved, "w-stop").right + FRAME_PADDING,
    );
  });

  it("reaches past a Stop's side label, so the frame never cuts it", () => {
    const source = framed();
    const stop = node(source, "w-stop");

    expect(flowContainerBounds(source, "workspace-1").right).toBe(
      boundsOf(stop).right + sideLabelSpan(stop.label) + FRAME_PADDING,
    );
  });

  it("finds the container under a point, and none outside every frame", () => {
    const source = framed();

    expect(flowContainerAt(source, { x: 150, y: 10 })).toBe("workspace-1");
    expect(flowContainerAt(source, { x: 250, y: 430 })).toBe("session-1");
    expect(flowContainerAt(source, { x: 650, y: 510 })).toBe("session-1");
    expect(flowContainerAt(source, { x: 3000, y: 3000 })).toBeUndefined();
  });
});
