import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import { carryOnNode, sessionContinuePrompt } from "../../../src/core/run/session-continue.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

const node = (id: string, type: ManifestNode["type"], label: string, parent?: string) =>
  ({ id, type, label, settings: {}, ...(parent === undefined ? {} : { parent }) }) as ManifestNode;

const then = (from: string, to: string, port = "out") => ({
  kind: "then" as const,
  from: { node: from, port },
  to: { node: to, port: "in" },
});

const android = {
  prefix: "fix-login-android",
  nodes: [
    node("session-1-start", "trigger", "Start"),
    node("session-1-plan", "agent", "Plan"),
    node("session-1-build", "agent", "Build"),
    node("session-1-stop", "output", "Stop"),
  ],
  wires: [
    then("session-1-start", "session-1-plan"),
    then("session-1-plan", "session-1-build"),
    then("session-1-build", "session-1-stop"),
  ],
};

const running: RunEvent = { kind: "running" };
const done: RunEvent = { kind: "done" };
const needsYou: RunEvent = { kind: "needs-you" };

const stored = (entries: [string, RunEvent][]): StoredEvent[] =>
  entries.map(([nodeId, event], i) => ({ ...event, nodeId, seq: i + 1, time: "t" }));

describe("sessionContinuePrompt", () => {
  it("runs the session's command again, naming the done nodes and the first unfinished one", () => {
    const events = stored([
      ["workspace-1-wait", { kind: "sent" }],
      ["session-1-start", running],
      ["session-1-start", done],
      ["session-1-plan", running],
      ["session-1-plan", done],
    ]);

    expect(sessionContinuePrompt(android, events)).toBe(
      "/fix-login-android:run Already done: NODE session-1-start (Start), NODE session-1-plan (Plan). Carry on from NODE session-1-build (Build); do not redo the done steps.",
    );
  });

  it("carries on from Stop when every other node is done", () => {
    const events = stored(
      ["session-1-start", "session-1-plan", "session-1-build"].flatMap(
        (id): [string, RunEvent][] => [
          [id, running],
          [id, done],
        ],
      ),
    );

    expect(sessionContinuePrompt(android, events)).toBe(
      "/fix-login-android:run Already done: NODE session-1-start (Start), NODE session-1-plan (Plan), NODE session-1-build (Build). Carry on from NODE session-1-stop (Stop); do not redo the done steps.",
    );
  });
});

describe("sessionContinuePrompt with the run's choices", () => {
  const events = stored([
    ["session-1-start", running],
    ["session-1-start", done],
  ]);
  const today =
    "/fix-login-android:run Already done: NODE session-1-start (Start). Carry on from NODE session-1-plan (Plan); do not redo the done steps.";

  it("adds the run's choices after the prompt, one space apart", () => {
    expect(sessionContinuePrompt(android, events, "Run choices: auto mode, go=yes")).toBe(
      `${today} Run choices: auto mode, go=yes`,
    );
  });

  it("is today's prompt when the run has no choices", () => {
    expect(sessionContinuePrompt(android, events, "")).toBe(today);
  });
});

describe("carryOnNode", () => {
  const start = node("start", "trigger", "Start");
  const stop = node("stop", "output", "Stop");
  const finished = (...ids: string[]) =>
    stored(
      ["start", ...ids].flatMap((id): [string, RunEvent][] => [
        [id, running],
        [id, done],
      ]),
    );

  const branch = {
    prefix: "p",
    nodes: [
      start,
      node("ask", "branch", "Ask"),
      node("a", "agent", "A"),
      node("b", "agent", "B"),
      stop,
    ],
    wires: [
      then("start", "ask"),
      then("ask", "a", "yes"),
      then("ask", "b", "no"),
      then("a", "stop"),
      then("b", "stop"),
    ],
  };

  const gate = {
    prefix: "p",
    nodes: [
      start,
      node("a", "agent", "A"),
      node("g", "gate", "Gate"),
      node("b", "agent", "B"),
      stop,
    ],
    wires: [then("start", "a"), then("a", "g"), then("g", "b"), then("b", "stop")],
  };

  const fork = {
    prefix: "p",
    nodes: [
      start,
      node("split", "fork", "Fork"),
      node("c", "agent", "C"),
      node("d", "agent", "D"),
      node("merge", "join", "Join"),
      stop,
    ],
    wires: [
      then("start", "split"),
      then("split", "c"),
      then("split", "d"),
      then("c", "merge"),
      then("d", "merge"),
      then("merge", "stop"),
    ],
  };

  const loop = {
    prefix: "p",
    nodes: [
      start,
      node("l", "loop", "Loop"),
      node("la", "agent", "LA", "l"),
      node("lb", "agent", "LB", "l"),
      stop,
    ],
    wires: [then("start", "l"), then("l", "la"), then("la", "lb"), then("l", "stop")],
  };

  const mergingBranch = {
    prefix: "p",
    nodes: [
      start,
      node("ask", "branch", "Ask"),
      node("g", "gate", "Gate"),
      node("a", "agent", "A"),
      node("b", "agent", "B"),
      node("c", "agent", "C"),
      node("d", "agent", "D"),
      stop,
    ],
    wires: [
      then("start", "ask"),
      then("ask", "g", "yes"),
      then("g", "a"),
      then("a", "c"),
      then("ask", "b", "no"),
      then("b", "c"),
      then("c", "d"),
      then("d", "stop"),
    ],
  };

  const gateSideMerge = {
    prefix: "p",
    nodes: [
      start,
      node("ask", "branch", "Ask"),
      node("g", "gate", "Gate"),
      node("b", "agent", "B"),
      node("c", "agent", "C"),
      node("d", "agent", "D"),
      stop,
    ],
    wires: [
      then("start", "ask"),
      then("ask", "g", "yes"),
      then("g", "c"),
      then("ask", "b", "no"),
      then("b", "c"),
      then("c", "d"),
      then("d", "stop"),
    ],
  };

  const nestedGateSide = {
    prefix: "p",
    nodes: [
      start,
      node("b1", "branch", "Outer"),
      node("b2", "branch", "Inner"),
      node("ga", "gate", "Gate"),
      node("q", "agent", "Q"),
      node("z", "agent", "Z"),
      node("m", "agent", "M"),
      stop,
    ],
    wires: [
      then("start", "b1"),
      then("b1", "b2", "yes"),
      then("b1", "z", "no"),
      then("b2", "ga", "yes"),
      then("b2", "q", "no"),
      then("ga", "m"),
      then("q", "m"),
      then("z", "m"),
      then("m", "stop"),
    ],
  };

  const bodyBranch = (frame: "loop") => ({
    prefix: "p",
    nodes: [
      start,
      node("f", frame, "Frame"),
      node("fbr", "branch", "Body branch", "f"),
      node("la", "agent", "LA", "f"),
      node("lb", "agent", "LB", "f"),
      node("lc", "agent", "LC", "f"),
      node("x", "agent", "X"),
      stop,
    ],
    wires: [
      then("start", "f"),
      then("f", "fbr", "body"),
      then("fbr", "la", "yes"),
      then("fbr", "lb", "no"),
      then("lb", "lc"),
      then("f", "x"),
      then("x", "stop"),
    ],
  });

  const frameSide = (frame: "loop", merged: boolean) => ({
    prefix: "p",
    nodes: [
      start,
      node("br", "branch", "Ask"),
      node("b", "agent", "B"),
      node("l", frame, "Frame"),
      node("la", "agent", "LA", "l"),
      node("lb", "agent", "LB", "l"),
      ...(merged ? [node("m", "agent", "M")] : []),
      stop,
    ],
    wires: [
      then("start", "br"),
      then("br", "l", "yes"),
      then("br", "b", "no"),
      then("l", "la", "out"),
      then("la", "lb"),
      ...(merged
        ? [then("l", "m"), then("b", "m"), then("m", "stop")]
        : [then("l", "stop"), then("b", "stop")]),
    ],
  });

  const gateSideMerging = {
    prefix: "p",
    nodes: [
      start,
      node("br", "branch", "Branch"),
      node("a", "agent", "A"),
      node("g", "gate", "Gate"),
      node("m", "agent", "M"),
      stop,
    ],
    wires: [
      then("start", "br"),
      then("br", "g", "yes"),
      then("br", "a", "no"),
      then("g", "m"),
      then("a", "m"),
      then("m", "stop"),
    ],
  };

  const nestedBranchesMerging = {
    prefix: "p",
    nodes: [
      start,
      node("br1", "branch", "Outer"),
      node("br2", "branch", "Left"),
      node("br5", "branch", "Right"),
      node("a3", "agent", "A3"),
      node("a4", "agent", "A4"),
      node("a6", "agent", "A6"),
      node("a7", "agent", "A7"),
      stop,
    ],
    wires: [
      then("start", "br1"),
      then("br1", "br2", "yes"),
      then("br1", "br5", "no"),
      then("br2", "a3", "yes"),
      then("br2", "a4", "no"),
      then("br5", "a6", "yes"),
      then("br5", "a7", "no"),
      then("a3", "a7"),
      then("a4", "a7"),
      then("a6", "a7"),
      then("a7", "stop"),
    ],
  };

  it.each([
    {
      name: "a taken branch side whose Agent is done",
      container: branch,
      events: finished("a"),
      expected: "stop",
    },
    { name: "an undecided branch", container: branch, events: finished(), expected: "ask" },
    {
      name: "a branch side whose Agent is still running",
      container: branch,
      events: [...finished(), ...stored([["a", running]])],
      expected: "a",
    },
    {
      name: "a branch side whose Agent needs you",
      container: branch,
      events: [...finished(), ...stored([["b", needsYou]])],
      expected: "b",
    },
    { name: "a gate after a done Agent", container: gate, events: finished("a"), expected: "g" },
    {
      name: "a gate with the Agent after it done",
      container: gate,
      events: finished("a", "b"),
      expected: "stop",
    },
    { name: "a fork with nothing done", container: fork, events: finished(), expected: "split" },
    {
      name: "a loop with its first body Agent done",
      container: loop,
      events: finished("la"),
      expected: "lb",
    },
    { name: "a loop with no body Agent done", container: loop, events: finished(), expected: "l" },
    {
      name: "a branch whose sides meet again, taken on the side without a gate",
      container: mergingBranch,
      events: finished("b", "c"),
      expected: "d",
    },
    {
      name: "a branch whose gate side merges straight into the other side",
      container: gateSideMerge,
      events: finished("c"),
      expected: "d",
    },
    {
      name: "a nested branch whose Gate side merges into the outer other side",
      container: nestedGateSide,
      events: finished("m"),
      expected: "stop",
    },
    {
      name: "a loop whose body branch took the side that is done",
      container: bodyBranch("loop"),
      events: finished("lb"),
      expected: "lc",
    },
    {
      name: "a branch taken on the side of a loop whose first body Agent is done",
      container: frameSide("loop", false),
      events: finished("la"),
      expected: "lb",
    },
    {
      name: "a branch taken on the side of a loop whose first body Agent is done, the sides meeting again",
      container: frameSide("loop", true),
      events: finished("la"),
      expected: "lb",
    },
    {
      name: "a gate-led branch side that merged into a done Agent",
      container: gateSideMerging,
      events: finished("m"),
      expected: "stop",
    },
    {
      name: "an Agent-free nested branch side that merged into a done Agent",
      container: nestedBranchesMerging,
      events: finished("a7"),
      expected: "stop",
    },
  ])("carries on from $expected after $name", ({ container, events, expected }) => {
    const next = container.nodes.find((candidate) => candidate.id === expected);

    expect(carryOnNode(container, events)?.id).toBe(expected);
    expect(sessionContinuePrompt(container, events)).toContain(
      `Carry on from NODE ${expected} (${next?.label});`,
    );
  });
});
