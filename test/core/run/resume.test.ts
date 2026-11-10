import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import { agentTurnText } from "../../../src/core/nodes/agent/execute.js";
import { forkTurnText } from "../../../src/core/nodes/fork/execute.js";
import { decideResume, ResumeError, type TranscriptTurn } from "../../../src/core/run/resume.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

const hash = "abc123";
const prefix = "fix-login";

const node = (id: string, type: ManifestNode["type"], parent?: string) =>
  ({
    id,
    type,
    label: id,
    settings: {},
    ...(parent === undefined ? {} : { parent }),
  }) as ManifestNode;

function stored(entries: [string, RunEvent][]): StoredEvent[] {
  return entries.map(([nodeId, event], i) => ({ ...event, nodeId, seq: i + 1, time: "t" }));
}

const agentTurn = (id: string, ended: boolean, lastAssistantText?: string): TranscriptTurn => ({
  userText: agentTurnText(prefix, id, { id, given: [], writes: [] }),
  ended,
  ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
});

const sent: RunEvent = { kind: "sent" };
const done: RunEvent = { kind: "done" };

describe("decideResume", () => {
  const manifest = {
    hash,
    prefix,
    nodes: [node("p1", "agent"), node("p2", "agent"), node("p3", "agent")],
  };
  const killedAtP2 = stored([
    ["p1", sent],
    ["p1", done],
    ["p2", sent],
  ]);

  it("gives no action to done, skipped, failed or waiting nodes", () => {
    const events = stored([
      ["p1", sent],
      ["p1", done],
      ["p2", { kind: "skipped" }],
      ["p3", { kind: "running" }],
      ["p3", { kind: "failed", payload: { message: "p3 failed: exit code 1" } }],
    ]);
    const nodes = [...manifest.nodes, node("p4", "agent")];

    expect(decideResume({ manifest: { hash, prefix, nodes }, events, turns: [] })).toEqual({});
  });

  it.each<[string, RunEvent[]]>([
    ["running again after a permission answer", [{ kind: "needs-you" }, { kind: "running" }]],
    ["waiting on a permission answer", [{ kind: "needs-you" }]],
  ])("settles an Agent that was %s from its transcript turn", (_, afterSend) => {
    const events = stored([
      ["p1", sent],
      ["p1", done],
      ["p2", sent],
      ...afterSend.map((event): [string, RunEvent] => ["p2", event]),
    ]);

    const actions = decideResume({
      manifest,
      events,
      turns: [agentTurn("p1", true, "A"), agentTurn("p2", true, "X")],
    });

    expect(actions).toEqual({ p2: { kind: "complete", stopMessage: "X" } });
  });

  it("sends an Agent killed between its sent mark and the send", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [agentTurn("p1", true, "A")],
    });

    expect(actions).toEqual({ p2: { kind: "send" } });
  });

  it("completes an Agent whose turn ended while the runner was dead, with its last text", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [agentTurn("p1", true, "A"), agentTurn("p2", true, "X")],
    });

    expect(actions).toEqual({ p2: { kind: "complete", stopMessage: "X" } });
  });

  it("waits for an Agent whose turn is still running", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [agentTurn("p1", true, "A"), agentTurn("p2", false)],
    });

    expect(actions).toEqual({ p2: { kind: "wait" } });
  });

  it("settles a hash-named build's Agent from a turn sent under its hash, its prefix", () => {
    const oldTurn = (id: string, lastAssistantText: string): TranscriptTurn => ({
      userText: agentTurnText(hash, id, { id, given: [], writes: [] }),
      ended: true,
      lastAssistantText,
    });

    const actions = decideResume({
      manifest: { ...manifest, prefix: hash },
      events: killedAtP2,
      turns: [oldTurn("p1", "A"), oldTurn("p2", "X")],
    });

    expect(actions).toEqual({ p2: { kind: "complete", stopMessage: "X" } });
  });

  it("does not take p1's turn for p10's", () => {
    const actions = decideResume({
      manifest: { hash, prefix, nodes: [node("p1", "agent"), node("p10", "agent")] },
      events: stored([["p1", sent]]),
      turns: [agentTurn("p10", true, "A")],
    });

    expect(actions).toEqual({ p1: { kind: "send" } });
  });

  describe("a loop body node in round 2", () => {
    const loopManifest = { hash, prefix, nodes: [node("l1", "loop"), node("r1", "agent", "l1")] };
    const round2 = stored([
      ["l1", { kind: "running" }],
      ["l1", { kind: "round", payload: { round: 1 } }],
      ["r1", sent],
      ["r1", { kind: "done", payload: { stopMessage: "round one" } }],
      ["l1", { kind: "round", payload: { round: 2 } }],
      ["r1", { kind: "reset" }],
      ["r1", sent],
    ]);

    it("sends again when only round 1's turn is in the transcript", () => {
      const actions = decideResume({
        manifest: loopManifest,
        events: round2,
        turns: [agentTurn("r1", true, "round one")],
      });

      expect(actions).toEqual({ r1: { kind: "send" } });
    });

    it("waits when round 2's turn is in the transcript and not ended", () => {
      const actions = decideResume({
        manifest: loopManifest,
        events: round2,
        turns: [agentTurn("r1", true, "round one"), agentTurn("r1", false)],
      });

      expect(actions).toEqual({ r1: { kind: "wait" } });
    });
  });

  it("refuses to guess when the transcript holds more turns than the node was sent", () => {
    const decide = () =>
      decideResume({
        manifest,
        events: killedAtP2,
        turns: [agentTurn("p2", true, "X"), agentTurn("p2", true, "Y")],
      });

    expect(decide).toThrow(ResumeError);
    expect(decide).toThrow(/p2/);
  });

  it("settles an Agent on its main turn text", () => {
    const agentManifest = { hash, prefix, nodes: [node("a1", "agent")] };
    const events = stored([["a1", sent]]);
    const turn = (ended: boolean): TranscriptTurn => ({
      userText: agentTurnText(prefix, "a1", { id: "a1", given: [], writes: [] }, undefined, [
        "blue",
      ]),
      ended,
      ...(ended ? { lastAssistantText: "DONE" } : {}),
    });

    expect(decideResume({ manifest: agentManifest, events, turns: [] })).toEqual({
      a1: { kind: "send" },
    });
    expect(decideResume({ manifest: agentManifest, events, turns: [turn(false)] })).toEqual({
      a1: { kind: "wait" },
    });
    expect(decideResume({ manifest: agentManifest, events, turns: [turn(true)] })).toEqual({
      a1: { kind: "complete", stopMessage: "DONE" },
    });
  });

  describe("a parallel section", () => {
    const sectionManifest = {
      hash,
      prefix,
      nodes: [node("f", "fork"), node("a1", "agent"), node("a2", "agent"), node("j", "join")],
    };
    const interrupted = (id: string) => ({
      kind: "fail",
      message: `${id} failed: parallel section was interrupted; Retry sends it again`,
    });
    const markerTurns: TranscriptTurn[] = [
      {
        userText: `${agentTurnText(prefix, "a1", { id: "a1", given: [], writes: [] })} ${agentTurnText(prefix, "a2", { id: "a2", given: [], writes: [] })}`,
        ended: true,
        lastAssistantText: "DONE",
      },
    ];
    const transcripts: [string, TranscriptTurn[]][] = [
      [
        "the fork turn",
        [
          {
            userText: forkTurnText(prefix, [
              { id: "a1", piece: "a1", given: [], writes: [] },
              { id: "a2", piece: "a2", given: [], writes: [] },
            ]),
            ended: true,
          },
        ],
      ],
      ["a turn holding both branch markers", markerTurns],
    ];

    it.each(transcripts)(
      "fails the fork, every sent branch and the join, and never resends or completes, with %s",
      (_, turns) => {
        const events = stored([
          ["f", sent],
          ["a1", sent],
          ["a2", sent],
          ["j", { kind: "running" }],
        ]);

        expect(decideResume({ manifest: sectionManifest, events, turns })).toEqual({
          f: interrupted("f"),
          a1: interrupted("a1"),
          a2: interrupted("a2"),
          j: interrupted("j"),
        });
      },
    );

    it("gives no action to a branch already done", () => {
      const events = stored([
        ["f", sent],
        ["a1", sent],
        ["a2", sent],
        ["j", { kind: "running" }],
        ["a1", { kind: "done", payload: { stopMessage: "A" } }],
      ]);

      expect(decideResume({ manifest: sectionManifest, events, turns: markerTurns })).toEqual({
        f: interrupted("f"),
        a2: interrupted("a2"),
        j: interrupted("j"),
      });
    });

    it("gives no action to a fully settled section", () => {
      const events = stored([
        ["f", sent],
        ["a1", sent],
        ["a2", sent],
        ["j", { kind: "running" }],
        ["a1", done],
        ["a2", { kind: "skipped" }],
        ["j", done],
        ["f", done],
      ]);

      expect(decideResume({ manifest: sectionManifest, events, turns: markerTurns })).toEqual({});
    });
  });

  describe("nodes that share a piece", () => {
    const onPiece = (id: string, type: ManifestNode["type"], piece: string) => ({
      ...node(id, type),
      piece,
    });
    const reviewTurn = (
      id: string,
      ended: boolean,
      lastAssistantText?: string,
    ): TranscriptTurn => ({
      userText: agentTurnText(prefix, "review", { id, given: [], writes: [] }),
      ended,
      ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
    });

    it("AT-20: resumes at a2 when the session died after a1 settled and before a2 was sent", () => {
      const shared = {
        hash,
        prefix,
        nodes: [onPiece("a1", "agent", "review"), onPiece("a2", "agent", "review")],
      };
      const events = stored([
        ["a1", sent],
        ["a1", done],
        ["a2", sent],
      ]);

      expect(
        decideResume({ manifest: shared, events, turns: [reviewTurn("a1", true, "A")] }),
      ).toEqual({ a2: { kind: "send" } });
      expect(
        decideResume({
          manifest: shared,
          events,
          turns: [reviewTurn("a1", true, "A"), reviewTurn("a2", true, "B")],
        }),
      ).toEqual({ a2: { kind: "complete", stopMessage: "B" } });
    });

    it("does not count a10's turn for a1, whose id begins a10's", () => {
      const shared = {
        hash,
        prefix,
        nodes: [onPiece("a10", "agent", "review"), onPiece("a1", "agent", "review")],
      };
      const events = stored([
        ["a10", sent],
        ["a10", done],
        ["a1", sent],
      ]);

      expect(
        decideResume({ manifest: shared, events, turns: [reviewTurn("a10", true, "A")] }),
      ).toEqual({ a1: { kind: "send" } });
    });

    it("AT-11: resumes after a settled section whose branches share a piece with a later node", () => {
      const shared = {
        hash,
        prefix,
        nodes: [
          node("f", "fork"),
          onPiece("b1", "agent", "review"),
          onPiece("b2", "agent", "review"),
          node("j", "join"),
          onPiece("a3", "agent", "review"),
        ],
      };
      const events = stored([
        ["f", sent],
        ["b1", sent],
        ["b2", sent],
        ["j", { kind: "running" }],
        ["b2", done],
        ["b1", done],
        ["j", done],
        ["f", done],
        ["a3", sent],
      ]);
      const forkTurn: TranscriptTurn = {
        userText: forkTurnText(prefix, [
          { id: "b1", piece: "review", given: [], writes: [] },
          { id: "b2", piece: "review", given: [], writes: [] },
        ]),
        ended: true,
        lastAssistantText: "Both done.",
      };

      expect(
        decideResume({
          manifest: shared,
          events,
          turns: [forkTurn, reviewTurn("a3", true, "C")],
        }),
      ).toEqual({ a3: { kind: "complete", stopMessage: "C" } });
    });

    it("AT-11: still fails an in-flight section whose branches share a piece", () => {
      const shared = {
        hash,
        prefix,
        nodes: [
          node("f", "fork"),
          onPiece("b1", "agent", "review"),
          onPiece("b2", "agent", "review"),
          node("j", "join"),
        ],
      };
      const events = stored([
        ["f", sent],
        ["b1", sent],
        ["b2", sent],
        ["j", { kind: "running" }],
      ]);
      const interrupted = (id: string) => ({
        kind: "fail",
        message: `${id} failed: parallel section was interrupted; Retry sends it again`,
      });

      expect(decideResume({ manifest: shared, events, turns: [reviewTurn("b1", true)] })).toEqual({
        f: interrupted("f"),
        b1: interrupted("b1"),
        b2: interrupted("b2"),
        j: interrupted("j"),
      });
    });

    it("AT-19: counts a turn with no node marker for a piece only one node uses", () => {
      const single = { hash, prefix, nodes: [onPiece("p1", "agent", "plan")] };
      const events = stored([["p1", sent]]);
      const unmarked: TranscriptTurn = {
        userText: `Use the Agent tool with subagent_type "${prefix}:plan" and the prompt "Go". Then reply DONE.`,
        ended: true,
        lastAssistantText: "X",
      };

      expect(decideResume({ manifest: single, events, turns: [unmarked] })).toEqual({
        p1: { kind: "complete", stopMessage: "X" },
      });
    });
  });

  it("fails an Agent whose turn was cut off by a session that ended, so Retry can send it again", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [agentTurn("p1", true, "A"), agentTurn("p2", false)],
      sessionRestarted: true,
    });

    expect(actions).toEqual({
      p2: {
        kind: "fail",
        message:
          "p2 failed: its Claude session ended before the turn finished; Retry sends it again",
      },
    });
  });

  it("still completes or sends a turn as usual when the session was restarted", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [agentTurn("p1", true, "A"), agentTurn("p2", true, "B")],
      sessionRestarted: true,
    });

    expect(actions).toEqual({ p2: { kind: "complete", stopMessage: "B" } });
  });

  it.each(["gate", "ask", "hardstop", "loop"] as const)(
    "reuses a decision recorded at a %s before the kill and asks only when there is none",
    (type) => {
      const decision =
        type === "gate"
          ? { nodeId: "h1", decision: "approved" as const }
          : { nodeId: "h1", decision: "answered" as const, answer: "blue" };
      const kind = type === "gate" ? "decided" : "answered";
      const human = {
        hash,
        prefix,
        nodes: [node("h1", type), node("p1", "agent", type === "loop" ? "h1" : undefined)],
      };
      const asking: [string, RunEvent][] =
        type === "loop"
          ? [
              ["h1", { kind: "running" }],
              ["h1", { kind: "needs-you" }],
            ]
          : [["h1", { kind: "needs-you" }]];

      expect(
        decideResume({
          manifest: human,
          events: stored([...asking, ["h1", { kind, payload: decision } as RunEvent]]),
          turns: [],
        }),
      ).toEqual({ h1: { kind: "reuse", decision } });
      expect(decideResume({ manifest: human, events: stored(asking), turns: [] })).toEqual({
        h1: { kind: "ask" },
      });
    },
  );

  it("asks again at a hard stop that was checking its condition when the runner stopped", () => {
    const manifest = { hash, prefix, nodes: [node("h1", "hardstop"), node("p1", "agent")] };

    expect(
      decideResume({ manifest, events: stored([["h1", { kind: "running" }]]), turns: [] }),
    ).toEqual({ h1: { kind: "ask" } });
  });

  it("does not reuse a loop answer given before the loop asked again", () => {
    const events = stored([
      ["l1", { kind: "running" }],
      ["l1", { kind: "needs-you" }],
      [
        "l1",
        { kind: "answered", payload: { nodeId: "l1", decision: "answered", answer: "again" } },
      ],
      ["l1", { kind: "running" }],
      ["l1", { kind: "needs-you" }],
    ]);

    expect(
      decideResume({
        manifest: { hash, prefix, nodes: [node("l1", "loop"), node("r1", "agent", "l1")] },
        events,
        turns: [],
      }),
    ).toEqual({ l1: { kind: "ask" } });
  });
});
