import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { edgeId, toViewEdges } from "../../../src/app/renderer/canvas/view.js";
import { flowSvg, pictureLayout } from "../../../src/core/flow/flow-svg.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import type { Point } from "../../../src/core/flow/wire-router.js";
import { canvas, pathCrossings, tidied } from "../../app/renderer/canvas/canvas-geometry.js";
import { featureLibrary } from "../../fixtures/feature-library.js";
import {
  agent,
  flow,
  flowSettings,
  forEach,
  fork,
  join,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

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

    expect(nodes).toHaveLength(8);
    expect(drawn(svg, "wire").map((wire) => wire.localName)).toEqual([
      "path",
      "path",
      "path",
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

  describe("flow containers", () => {
    const containers = (): Flow =>
      flow(
        [
          at(trigger("ws-start"), 0, -400),
          at(output("ws-stop"), 200, -400),
          at(trigger("s-start"), 0, 0),
          at(agent("a"), 200, 0),
          at(loop("rounds"), 500, 0),
          at(agent("write"), 500, 160, "rounds"),
          at(output("s-stop"), 900, 0),
        ],
        [
          thenWire("ws-start", "ws-stop"),
          thenWire("s-start", "a"),
          thenWire("a", "rounds"),
          thenWire("rounds", "s-stop"),
        ],
        flowSettings,
        {
          containers: [
            workspaceContainer(["ws-start", "ws-stop"]),
            sessionContainer(["s-start", "a", "rounds", "s-stop"], { name: "review" }),
          ],
        },
      );

    const strictlyEncloses = (outer: Box, inner: Box): boolean =>
      outer.left < inner.left &&
      outer.top < inner.top &&
      outer.right > inner.right &&
      outer.bottom > inner.bottom;

    it("draws one frame per container, and no session frame", () => {
      const svg = flowSvg(containers());
      const frames = drawn(svg, "container-frame");

      expect(frames.map((frame) => frame.getAttribute("data-id"))).toEqual([
        "workspace-1",
        "session-1",
      ]);
      expect(drawn(svg, "session-frame")).toHaveLength(0);
    });

    it.each([
      ["workspace-1", ["ws-start", "ws-stop"], ["s-start", "a", "rounds", "write", "s-stop"]],
      ["session-1", ["s-start", "a", "rounds", "write", "s-stop"], ["ws-start", "ws-stop"]],
    ])("pads %s's frame around its members and their body nodes only", (id, inside, outside) => {
      const svg = flowSvg(containers());
      const frame = boxOf(byId(drawn(svg, "container-frame"), id));
      const nodes = drawn(svg, "node");

      for (const member of inside)
        expect(strictlyEncloses(frame, boxOf(byId(nodes, member))), member).toBe(true);
      for (const other of outside)
        expect(encloses(frame, boxOf(byId(nodes, other))), other).toBe(false);
    });

    it.each([
      ["workspace-1", /workspace/i],
      ["session-1", /review/],
    ])("labels %s's frame with its name", (id, label) => {
      const frame = byId(drawn(flowSvg(containers()), "container-frame"), id);

      expect(frame.textContent).toMatch(label);
    });

    const wireEnds = (element: Element) => {
      const numbers = (element.getAttribute("d") ?? "").match(/-?\d+/g)?.map(Number) ?? [];
      return { x1: numbers[0], y1: numbers[1], x2: numbers.at(-1) };
    };

    it("draws the canvas path's wires to and from the workspace frame", () => {
      const base = containers();
      const svg = flowSvg(
        parseFlow({
          ...base,
          nodes: [
            ...base.nodes,
            at(trigger("canvas-start"), -300, -400),
            at(output("canvas-stop"), 600, -400),
          ],
          wires: [
            ...base.wires,
            wire("canvas-start", "out", "workspace-1", "flow-in"),
            wire("workspace-1", "flow-out", "canvas-stop", "in"),
          ],
        }),
      );
      const frame = boxOf(byId(drawn(svg, "container-frame"), "workspace-1"));
      const nodes = drawn(svg, "node");
      const start = boxOf(byId(nodes, "canvas-start"));
      const stop = boxOf(byId(nodes, "canvas-stop"));
      const ends = drawn(svg, "wire").map(wireEnds);

      expect(ends).toContainEqual({ x1: start.right, y1: expect.any(Number), x2: frame.left });
      expect(ends).toContainEqual({ x1: frame.right, y1: expect.any(Number), x2: stop.left });
    });

    it("keeps every container frame inside the picture", () => {
      const svg = flowSvg(containers());
      const background = boxOf(single(drawn(svg, "background")));
      const frames = drawn(svg, "container-frame");

      expect(frames).toHaveLength(2);
      for (const frame of frames) expect(encloses(background, boxOf(frame))).toBe(true);
    });
  });

  it.each([
    ["an empty label", ""],
    ["a 200-character label", "x".repeat(200)],
  ])("parses with %s", (_name, label) => {
    expect(() => parse(flowSvg(flow([at({ ...agent("a"), label }, 0, 0)], [])))).not.toThrow();
  });

  it("draws no wire for a flow with no wires", () => {
    const svg = flowSvg(
      flow([at(agent("a"), 0, 0), at(agent("b"), 300, 0)], [], flowSettings, {
        containers: [sessionContainer(["a", "b"])],
      }),
    );
    expect(drawn(svg, "wire")).toHaveLength(0);
  });

  describe("a Fork and a Join", () => {
    const BAR_PADDING = 8;
    const CHAR_RATIO = 0.6;

    const parallel = (): Flow =>
      flow(
        [
          at(agent("plan"), 0, 32),
          at({ ...fork("split"), label: "Split the work" }, 230, 0),
          at(agent("left"), 330, -40),
          at(agent("right"), 330, 104),
          at({ ...join("merge"), label: "Merge the results" }, 560, 0),
          at(agent("ship"), 660, 32),
        ],
        [
          thenWire("plan", "split"),
          thenWire("split", "left"),
          thenWire("split", "right"),
          thenWire("left", "merge"),
          thenWire("right", "merge"),
          thenWire("merge", "ship"),
        ],
      );

    const textsOf = (group: Element): Element[] => Array.from(group.getElementsByTagName("text"));

    const textReading = (group: Element, content: string): Element => {
      const found = textsOf(group).find((text) => text.textContent === content);
      if (found === undefined)
        throw new Error(
          `no <text> reading "${content}" in ${group.getAttribute("data-id")}: ${textsOf(group)
            .map((text) => JSON.stringify(text.textContent))
            .join(", ")}`,
        );
      return found;
    };

    const fontSizeOf = (text: Element): number => Number(text.getAttribute("font-size") ?? "16");

    const lengthOf = (text: Element): number =>
      (text.textContent ?? "").length * fontSizeOf(text) * CHAR_RATIO;

    const labelBox = (text: Element): Box => {
      const x = Number(text.getAttribute("x"));
      const y = Number(text.getAttribute("y"));
      const length = lengthOf(text);
      const anchor = text.getAttribute("text-anchor") ?? "start";
      const left = anchor === "middle" ? x - length / 2 : anchor === "end" ? x - length : x;
      return { left, top: y - fontSizeOf(text), right: left + length, bottom: y };
    };

    const overlaps = (a: Box, b: Box): boolean =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    it.each([
      ["split", "PARALLEL START"],
      ["merge", "PARALLEL END"],
    ])(
      "draws %s's tag rotated a quarter turn about the bar's centre, inside the bar",
      (id, tag) => {
        const group = byId(drawn(flowSvg(parallel()), "node"), id);
        const bar = boxOf(group);
        const text = textReading(group, tag);
        const cx = (bar.left + bar.right) / 2;
        const cy = (bar.top + bar.bottom) / 2;

        expect(bar.right - bar.left).toBe(28);
        expect(bar.bottom - bar.top).toBe(112);
        expect(text.getAttribute("transform")).toBe(`rotate(-90 ${cx} ${cy})`);
        expect(text.getAttribute("text-anchor")).toBe("middle");
        expect(lengthOf(text)).toBeLessThanOrEqual(bar.bottom - bar.top - BAR_PADDING);
        expect(fontSizeOf(text)).toBeLessThanOrEqual(bar.right - bar.left);
      },
    );

    it.each([
      ["split", "Split the work"],
      ["merge", "Merge the results"],
    ])("draws %s's label above the bar, clear of every other node", (id, label) => {
      const nodes = drawn(flowSvg(parallel()), "node");
      const group = byId(nodes, id);
      const bar = boxOf(group);
      const box = labelBox(textReading(group, label));

      expect(box.bottom).toBeLessThan(bar.top);
      for (const other of nodes.filter((node) => node.getAttribute("data-id") !== id))
        expect(
          overlaps(box, boxOf(other)),
          `label of ${id} over ${other.getAttribute("data-id")}`,
        ).toBe(false);
    });
  });

  describe("wires on a tidied long flow", () => {
    const widths = [1600, 1400, 960, 860];

    const tidiedLibraries = new Map<number, Promise<Flow>>();
    const tidiedAt = (width: number): Promise<Flow> => {
      const known = tidiedLibraries.get(width);
      if (known !== undefined) return known;
      const made = tidied(featureLibrary, { ...canvas, width });
      tidiedLibraries.set(width, made);
      return made;
    };

    const wirePaths = (svg: string): string[] =>
      drawn(svg, "wire").map((element) => element.getAttribute("d") ?? "");

    const pointsOf = (d: string): Point[] =>
      Array.from(d.matchAll(/([MLHV])\s*(-?\d+(?:\.\d+)?)(?:[ ,](-?\d+(?:\.\d+)?))?/g)).reduce<
        Point[]
      >((points, [, command, first, second]) => {
        const last = points.at(-1) ?? { x: 0, y: 0 };
        if (command === "H") return [...points, { x: Number(first), y: last.y }];
        if (command === "V") return [...points, { x: last.x, y: Number(first) }];
        return [...points, { x: Number(first), y: Number(second) }];
      }, []);

    const within = (current: Flow, id: string, scope: string): boolean => {
      const parent = current.nodes.find((node) => node.id === id)?.parent;
      return id === scope || (parent !== undefined && within(current, parent, scope));
    };

    it.each(widths)(
      "draws no wire over a node or body it does not connect, only in straight segments, at %i px",
      async (width) => {
        const current = await tidiedAt(width);
        const svg = flowSvg(current);
        const { boxes, bodies, wires } = pictureLayout(current);
        const paths = wirePaths(svg);

        expect(paths).toHaveLength(wires.length);
        const crossing = wires.flatMap(({ from, to }, index) => {
          const others = [...boxes].filter(([id]) => id !== from && id !== to);
          const foreign = [...bodies].filter(
            ([scope]) => !within(current, from, scope) && !within(current, to, scope),
          );
          const crossed = pathCrossings(
            pointsOf(paths[index] ?? ""),
            [...others, ...foreign].map(([, bounds]) => bounds),
          );
          return crossed.length === 0 ? [] : [`${from}->${to}`];
        });
        expect(crossing).toEqual([]);
      },
    );

    it.each(widths)(
      "draws every wire the canvas routes on the canvas's route, rounded, at %i px",
      async (width) => {
        const current = await tidiedAt(width);
        const paths = wirePaths(flowSvg(current));
        expect(paths).toHaveLength(current.wires.length);
        const canvasRoutes = toViewEdges(current).flatMap((edge) =>
          edge.type === "routed" && edge.data !== undefined && "points" in edge.data
            ? [[edge.id, edge.data.points] as const]
            : [],
        );
        const pictureRoute = (id: string): Point[] =>
          pointsOf(paths[current.wires.findIndex((wire) => edgeId(wire) === id)] ?? "");

        expect(canvasRoutes.length).toBeGreaterThan(0);
        expect(Object.fromEntries(canvasRoutes.map(([id]) => [id, pictureRoute(id)]))).toEqual(
          Object.fromEntries(
            canvasRoutes.map(([id, points]) => [
              id,
              points.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })),
            ]),
          ),
        );
      },
    );

    it("draws a forward wire on the same row as today's path", () => {
      const current = flow([at(agent("a"), 0, 0), at(agent("b"), 300, 0)], [thenWire("a", "b")]);
      const paths = wirePaths(flowSvg(current));
      const index = pictureLayout(current).wires.findIndex(
        ({ from, to }) => from === "a" && to === "b",
      );

      expect(paths[index]).toBe("M170,24 H235 V24 H300");
    });

    it.each([
      [
        1600,
        [
          ["canvas-start", "session-1", "M48,1442 H169 V1442 H290"],
          ["session-1", "canvas-stop", "M1841,1442 H1916 V1442 H1991"],
        ],
      ],
      [
        960,
        [
          ["canvas-start", "session-1", "M48,2103 H169 V2104 H290"],
          ["session-1", "canvas-stop", "M1516,2104 H1591 V2103 H1666"],
        ],
      ],
    ])(
      "draws the wires to and from a session frame as today's paths at %i px",
      async (width, expected) => {
        const current = await tidiedAt(width);
        const frames = new Set(current.containers.map(({ id }) => id));
        const paths = wirePaths(flowSvg(current));

        expect(
          pictureLayout(current)
            .wires.map(({ from, to }, index) => [from, to, paths[index]])
            .filter(([from, to]) => frames.has(from ?? "") || frames.has(to ?? "")),
        ).toEqual(expected);
      },
    );
  });
});
