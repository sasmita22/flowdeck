import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../src/core/compiler/lower.js";
import { agentTurnText } from "../../../src/core/nodes/agent/execute.js";
import { decideResume, ResumeError, type TranscriptTurn } from "../../../src/core/run/resume.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

const hash = "abc123";

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

const promptTurn = (id: string, ended: boolean, lastAssistantText?: string): TranscriptTurn => ({
  userText: `<command-message>${hash}:${id}</command-message> <command-name>/${hash}:${id}</command-name>`,
  ended,
  ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
});

const sent: RunEvent = { kind: "sent" };
const done: RunEvent = { kind: "done" };

describe("decideResume", () => {
  const manifest = {
    hash,
    nodes: [node("p1", "prompt"), node("p2", "prompt"), node("p3", "prompt")],
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
    const nodes = [...manifest.nodes, node("p4", "prompt")];

    expect(decideResume({ manifest: { hash, nodes }, events, turns: [] })).toEqual({});
  });

  it("sends a Prompt killed between its sent mark and the send", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [promptTurn("p1", true, "A")],
    });

    expect(actions).toEqual({ p2: { kind: "send" } });
  });

  it("completes a Prompt whose turn ended while the runner was dead, with its last text", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [promptTurn("p1", true, "A"), promptTurn("p2", true, "X")],
    });

    expect(actions).toEqual({ p2: { kind: "complete", stopMessage: "X" } });
  });

  it("waits for a Prompt whose turn is still running", () => {
    const actions = decideResume({
      manifest,
      events: killedAtP2,
      turns: [promptTurn("p1", true, "A"), promptTurn("p2", false)],
    });

    expect(actions).toEqual({ p2: { kind: "wait" } });
  });

  it("does not take p1's turn for p10's", () => {
    const actions = decideResume({
      manifest: { hash, nodes: [node("p1", "prompt"), node("p10", "prompt")] },
      events: stored([["p1", sent]]),
      turns: [promptTurn("p10", true, "A")],
    });

    expect(actions).toEqual({ p1: { kind: "send" } });
  });

  describe("a loop body node in round 2", () => {
    const loopManifest = { hash, nodes: [node("l1", "loop"), node("r1", "prompt", "l1")] };
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
        turns: [promptTurn("r1", true, "round one")],
      });

      expect(actions).toEqual({ r1: { kind: "send" } });
    });

    it("waits when round 2's turn is in the transcript and not ended", () => {
      const actions = decideResume({
        manifest: loopManifest,
        events: round2,
        turns: [promptTurn("r1", true, "round one"), promptTurn("r1", false)],
      });

      expect(actions).toEqual({ r1: { kind: "wait" } });
    });
  });

  it("refuses to guess when the transcript holds more turns than the node was sent", () => {
    const decide = () =>
      decideResume({
        manifest,
        events: killedAtP2,
        turns: [promptTurn("p2", true, "X"), promptTurn("p2", true, "Y")],
      });

    expect(decide).toThrow(ResumeError);
    expect(decide).toThrow(/p2/);
  });

  it("settles an Agent on its main turn text", () => {
    const agentManifest = { hash, nodes: [node("a1", "agent")] };
    const events = stored([["a1", sent]]);
    const turn = (ended: boolean): TranscriptTurn => ({
      userText: `The user answered: blue. ${agentTurnText(hash, "a1")}`,
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

  it("fails a Script that was running and never reruns it", () => {
    const actions = decideResume({
      manifest: { hash, nodes: [node("s1", "script")] },
      events: stored([["s1", { kind: "running" }]]),
      turns: [],
    });

    expect(actions).toEqual({
      s1: { kind: "fail", message: "s1 failed: was running when the runner stopped" },
    });
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
        nodes: [node("h1", type), node("p1", "prompt", type === "loop" ? "h1" : undefined)],
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
        manifest: { hash, nodes: [node("l1", "loop"), node("r1", "prompt", "l1")] },
        events,
        turns: [],
      }),
    ).toEqual({ l1: { kind: "ask" } });
  });
});
