import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { flowSvg } from "../../../src/core/flow/flow-svg.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { agent, flow, forEach, loop, thenWire } from "../../fixtures/flow-builders.js";

type Box = { left: number; top: number; right: number; bottom: number };

const parse = (svg: string): Document =>
  new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") throw new Error(message);
    },
  }).parseFromString(svg, "image/svg+xml");

const at = <T extends object>(node: T, x: number, y: number, parent?: string) => ({
  ...node,
  position: { x, y },
  ...(parent === undefined ? {} : { parent }),
});

const drawn = (svg: string, kind: string): Element[] =>
  Array.from(parse(svg).getElementsByTagName("*")).filter(
    (element) => element.getAttribute("data-kind") === kind,
  );

const rectOf = (element: Element): Element => {
  const rect =
    element.localName === "rect" ? element : element.getElementsByTagName("rect").item(0);
  if (rect === null) throw new Error(`no rect in ${element.getAttribute("data-kind")}`);
  return rect;
};

const boxOf = (element: Element): Box => {
  const rect = rectOf(element);
  const read = (name: string) => Number(rect.getAttribute(name));
  return {
    left: read("x"),
    top: read("y"),
    right: read("x") + read("width"),
    bottom: read("y") + read("height"),
  };
};

const byId = (elements: Element[], id: string): Element => {
  const found = elements.find((element) => element.getAttribute("data-id") === id);
  if (found === undefined) throw new Error(`nothing drawn for ${id}`);
  return found;
};

const single = (elements: Element[]): Element => {
  const [only, ...rest] = elements;
  if (only === undefined || rest.length > 0)
    throw new Error(`expected one element, drew ${elements.length}`);
  return only;
};

const encloses = (outer: Box, inner: Box): boolean =>
  outer.left <= inner.left &&
  outer.top <= inner.top &&
  outer.right >= inner.right &&
  outer.bottom >= inner.bottom;

const withSessionFrame = (base: Flow, nodes: string[]): Flow => ({
  ...base,
  session: { ...base.session, frame: { nodes } },
});

const loopWithBody = (): Flow => {
  const built = flow(
    [
      at(agent("plan"), 0, 0),
      at(loop("rounds"), 300, 0),
      at(agent("write"), 300, 120, "rounds"),
      at(agent("check"), 520, 120, "rounds"),
    ],
    [
      thenWire("plan", "rounds"),
      thenWire("write", "check"),
      thenWire("plan", "write"),
      thenWire("rounds", "check"),
    ],
  );
  return {
    ...built,
    notes: [
      {
        id: "n1",
        text: "Remember the tests",
        position: { x: 0, y: 260 },
        size: { width: 160, height: 80 },
      },
    ],
  };
};

describe("flowSvg", () => {
  it("is checked by a parser that rejects unescaped markup", () => {
    expect(() => parse("<svg><text><b> & 'x'</text></svg>")).toThrow();
  });

  it("draws the same flow to the same string, and the string parses", () => {
    const first = flowSvg(loopWithBody());
    expect(flowSvg(loopWithBody())).toBe(first);
    expect(parse(first).documentElement?.localName).toBe("svg");
  });

  it("draws every node, wire, the loop frame, the note and one background", () => {
    const svg = flowSvg(loopWithBody());
    const nodes = drawn(svg, "node");
    const frames = drawn(svg, "frame");

    expect(nodes).toHaveLength(4);
    expect(drawn(svg, "wire").map((wire) => wire.localName)).toEqual([
      "path",
      "path",
      "path",
      "path",
    ]);
    const frame = boxOf(single(frames));
    for (const id of ["rounds", "write", "check"])
      expect(encloses(frame, boxOf(byId(nodes, id)))).toBe(true);
    expect(parse(svg).documentElement?.textContent).toContain("Remember the tests");
    expect(drawn(svg, "background").map((background) => background.localName)).toEqual(["rect"]);
  });

  it("escapes a label's markup characters", () => {
    const svg = flowSvg(flow([at({ ...agent("a"), label: "<b> & 'x'" }, 0, 0)], []));
    expect(svg).toContain("&lt;b&gt; &amp; &apos;x&apos;");
    expect(() => parse(svg)).not.toThrow();
  });

  it("frames a Loop with an empty body around the Loop alone", () => {
    const svg = flowSvg(flow([at(loop("rounds"), 100, 100)], []));
    const frame = boxOf(single(drawn(svg, "frame")));
    expect(encloses(frame, boxOf(byId(drawn(svg, "node"), "rounds")))).toBe(true);
  });

  it("frames a For each inside a Loop inside the Loop's frame", () => {
    const svg = flowSvg(
      flow([at(loop("rounds"), 0, 0), at(forEach("units"), 0, 140, "rounds")], []),
    );
    const frames = drawn(svg, "frame");
    expect(frames).toHaveLength(2);
    const [outer, inner] = frames.map(boxOf) as [Box, Box];
    expect(encloses(outer, inner)).toBe(true);
    expect(encloses(inner, outer)).toBe(false);
  });

  it("draws the session frame around its nodes only when the session names one", () => {
    const base = flow([at(agent("a"), 0, 0), at(agent("b"), 300, 200)], [thenWire("a", "b")]);
    expect(drawn(flowSvg(base), "session-frame")).toHaveLength(0);

    const svg = flowSvg(withSessionFrame(base, ["a", "b"]));
    const frame = boxOf(single(drawn(svg, "session-frame")));
    const nodes = drawn(svg, "node");
    for (const id of ["a", "b"]) expect(encloses(frame, boxOf(byId(nodes, id)))).toBe(true);
  });

  it.each([
    ["an empty label", ""],
    ["a 200-character label", "x".repeat(200)],
  ])("parses with %s", (_name, label) => {
    expect(() => parse(flowSvg(flow([at({ ...agent("a"), label }, 0, 0)], [])))).not.toThrow();
  });

  it("draws no wire for a flow with no wires", () => {
    const svg = flowSvg(flow([at(agent("a"), 0, 0), at(agent("b"), 300, 0)], []));
    expect(drawn(svg, "wire")).toHaveLength(0);
  });
});
