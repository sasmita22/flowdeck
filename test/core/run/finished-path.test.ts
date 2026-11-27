import { describe, expect, it } from "vitest";
import {
  hasFinishedPath,
  sessionOverlayOf,
  sessionStatesOf,
} from "../../../src/core/run/finished-path.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";

type Kind = "trigger" | "output" | "agent" | "branch" | "fork" | "join" | "loop" | "gate";

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

const ran = (...ids: string[]): (RunEvent & { nodeId: string })[] =>
  ids.flatMap((nodeId) => [
    { nodeId, kind: "running" as const },
    { nodeId, kind: "done" as const },
  ]);

const forked = {
  nodes: [
    ...ends,
    node("f", "fork"),
    node("a", "agent"),
    node("b", "agent"),
    node("j", "join"),
    node("c", "agent"),
  ],
  wires: [
    then("start", "f"),
    then("f", "a"),
    then("f", "b"),
    then("a", "j"),
    then("b", "j"),
    then("j", "c"),
    then("c", "stop"),
  ],
};

const branched = (untaken: ReturnType<typeof node>) => ({
  nodes: [...ends, node("br", "branch"), node("a", "agent"), untaken],
  wires: [
    then("start", "br"),
    then("br", "a", "yes"),
    then("br", untaken.id, "no"),
    then("a", "stop"),
    then(untaken.id, "stop"),
  ],
});

describe("sessionStatesOf", () => {
  it("shows the Fork and Join of a finished forked session done", () => {
    expect(sessionStatesOf(forked, ran("start", "a", "b", "c", "stop"))).toEqual({
      f: "done",
      j: "done",
    });
  });

  it("shows the taken Branch done and the untaken Gate skipped", () => {
    expect(sessionStatesOf(branched(node("g", "gate")), ran("start", "a", "stop"))).toEqual({
      br: "done",
      g: "skipped",
    });
  });

  it("shows an Agent on the untaken side skipped", () => {
    expect(sessionStatesOf(branched(node("a2", "agent")), ran("start", "a", "stop"))).toEqual({
      br: "done",
      a2: "skipped",
    });
  });

  it("shows both Agent-free sides of a finished Branch done", () => {
    const container = {
      nodes: [...ends, node("br", "branch"), node("g", "gate"), node("g2", "gate")],
      wires: [
        then("start", "br"),
        then("br", "g", "yes"),
        then("br", "g2", "no"),
        then("g", "stop"),
        then("g2", "stop"),
      ],
    };

    expect(sessionStatesOf(container, ran("start", "stop"))).toEqual({
      br: "done",
      g: "done",
      g2: "done",
    });
  });

  it("shows the Fork done and leaves the Join waiting while the session runs", () => {
    expect(sessionStatesOf(forked, ran("start", "a"))).toEqual({ f: "done" });
  });

  it("shows a Gate done only once a finished Agent lies after it", () => {
    const container = {
      nodes: [
        ...ends,
        node("g1", "gate"),
        node("a", "agent"),
        node("g2", "gate"),
        node("b", "agent"),
      ],
      wires: [
        then("start", "g1"),
        then("g1", "a"),
        then("a", "g2"),
        then("g2", "b"),
        then("b", "stop"),
      ],
    };

    expect(sessionStatesOf(container, ran("start", "a"))).toEqual({ g1: "done" });
  });

  it("shows a Gate between Agents in a Loop body done", () => {
    const container = {
      nodes: [
        ...ends,
        node("l", "loop"),
        node("la", "agent", "l"),
        node("lg", "gate", "l"),
        node("lb", "agent", "l"),
      ],
      wires: [
        then("start", "l"),
        then("l", "la"),
        then("la", "lg"),
        then("lg", "lb"),
        then("l", "stop"),
      ],
    };

    expect(sessionStatesOf(container, ran("start", "la", "lb", "stop"))).toEqual({
      l: "done",
      lg: "done",
    });
  });

  describe.each(["loop"] as const)("a %s body ending in a Gate", (frame) => {
    const container = {
      nodes: [...ends, node("l", frame), node("la", "agent", "l"), node("lg", "gate", "l")],
      wires: [then("start", "l"), then("la", "lg"), then("l", "stop")],
    };

    it("shows the Gate done once the session ends", () => {
      expect(sessionStatesOf(container, ran("start", "la", "stop"))).toEqual({
        l: "done",
        lg: "done",
      });
    });

    it("shows the Gate done while an Agent after the frame runs", () => {
      const running = {
        nodes: [...container.nodes, node("b", "agent")],
        wires: [then("start", "l"), then("la", "lg"), then("l", "b"), then("b", "stop")],
      };

      expect(sessionStatesOf(running, ran("start", "la", "b"))).toEqual({
        l: "done",
        lg: "done",
      });
    });
  });

  it.each(["loop"] as const)(
    "shows a Branch done in a %s body when its taken side has no wire",
    (frame) => {
      const container = {
        nodes: [
          ...ends,
          node("l", frame),
          node("la", "agent", "l"),
          node("br", "branch", "l"),
          node("lb", "agent", "l"),
        ],
        wires: [then("start", "l"), then("la", "br"), then("br", "lb", "yes"), then("l", "stop")],
      };

      expect(sessionStatesOf(container, ran("start", "la", "stop"))).toEqual({
        l: "done",
        br: "done",
        lb: "skipped",
      });
    },
  );

  it("shows the Join ending a Loop body done", () => {
    const container = {
      nodes: [
        ...ends,
        node("l", "loop"),
        node("f", "fork", "l"),
        node("x", "agent", "l"),
        node("y", "agent", "l"),
        node("j", "join", "l"),
      ],
      wires: [
        then("start", "l"),
        then("f", "x"),
        then("f", "y"),
        then("x", "j"),
        then("y", "j"),
        then("l", "stop"),
      ],
    };

    expect(sessionStatesOf(container, ran("start", "x", "y", "stop"))).toEqual({
      l: "done",
      f: "done",
      j: "done",
    });
  });

  it("shows a Loop whose Agents never ran skipped on the untaken side", () => {
    const container = {
      nodes: [
        ...ends,
        node("br", "branch"),
        node("l", "loop"),
        node("la", "agent", "l"),
        node("g", "gate"),
        node("c", "agent"),
      ],
      wires: [
        then("start", "br"),
        then("br", "l", "yes"),
        then("br", "g", "no"),
        then("l", "c"),
        then("g", "c"),
        then("c", "stop"),
      ],
    };

    expect(sessionStatesOf(container, ran("start", "c", "stop"))).toEqual({
      br: "done",
      l: "skipped",
      la: "skipped",
      g: "done",
    });
  });

  it("shows a Gate done on a side that rejoins a side with no step", () => {
    const container = {
      nodes: [...ends, node("br", "branch"), node("g", "gate"), node("c", "agent")],
      wires: [
        then("start", "br"),
        then("br", "c", "yes"),
        then("br", "g", "no"),
        then("g", "c"),
        then("c", "stop"),
      ],
    };

    expect(sessionStatesOf(container, ran("start", "c", "stop"))).toEqual({
      br: "done",
      g: "done",
    });
  });

  it("derives nothing for a node with a state of its own", () => {
    const container = {
      nodes: [...ends, node("a", "agent"), node("hs", "gate"), node("b", "agent")],
      wires: [then("start", "a"), then("a", "hs"), then("hs", "b"), then("b", "stop")],
    };
    const events = [
      ...ran("start", "a"),
      { nodeId: "hs", kind: "running" as const },
      { nodeId: "hs", kind: "failed" as const, payload: { message: "hs failed" } },
    ];

    expect(sessionStatesOf(container, events)).toEqual({});
  });

  it("derives nothing for a session that never started", () => {
    expect(sessionStatesOf(forked, [])).toEqual({});
  });
});

describe("sessionOverlayOf", () => {
  it("merges the derived states of every session", () => {
    const rename = (id: string) => `s2-${id}`;
    const second = {
      nodes: forked.nodes.map((each) => ({ ...each, id: rename(each.id) })),
      wires: forked.wires.map((wire) =>
        then(rename(wire.from.node), rename(wire.to.node), wire.from.port),
      ),
    };

    expect(
      sessionOverlayOf(
        [forked, second],
        [...ran("start", "a", "b", "c", "stop"), ...ran(...["start", "a"].map(rename))],
      ),
    ).toEqual({ f: "done", j: "done", "s2-f": "done" });
  });
});
