import { describe, expect, it } from "vitest";
import { parseTranscriptTurns } from "../../../src/adapters/claude/transcript-turns.js";

const command = (id: string) =>
  `<command-message>h:${id}</command-message>\n<command-name>/h:${id}</command-name>`;

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

const assistant = (stopReason: string | null, content: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", stop_reason: stopReason, content },
  });

const text = (value: string) => ({ type: "text", text: value });
const toolUse = { type: "tool_use", id: "t1", name: "Agent", input: { prompt: "Go" } };
const toolResult = [{ type: "tool_result", tool_use_id: "t1", content: "done" }];
const stopSummary = JSON.stringify({ type: "system", subtype: "stop_hook_summary" });

const jsonl = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("parseTranscriptTurns", () => {
  it("reads a user turn that ended with the last assistant text", () => {
    const turns = parseTranscriptTurns(
      jsonl(user(command("p1")), assistant("end_turn", [text("OK")]), stopSummary),
    );

    expect(turns).toEqual([{ userText: command("p1"), ended: true, lastAssistantText: "OK" }]);
  });

  it("reads the text of a reply written as one entry per block, each marked end_turn", () => {
    const turns = parseTranscriptTurns(
      jsonl(
        user(command("p1")),
        assistant("end_turn", [{ type: "thinking", thinking: "" }]),
        assistant("end_turn", [text("ALPHA")]),
        stopSummary,
      ),
    );

    expect(turns).toEqual([{ userText: command("p1"), ended: true, lastAssistantText: "ALPHA" }]);
  });

  it("marks a turn with no end_turn after it as not ended", () => {
    const turns = parseTranscriptTurns(
      jsonl(user(command("p1")), assistant("tool_use", [text("working"), toolUse])),
    );

    expect(turns).toEqual([{ userText: command("p1"), ended: false }]);
  });

  it("does not end a turn at end_turn before its stop hook summary is written", () => {
    const turns = parseTranscriptTurns(
      jsonl(
        user(command("p1")),
        assistant("end_turn", [{ type: "thinking", thinking: "" }]),
        assistant("end_turn", [text("ALPHA")]),
      ),
    );

    expect(turns).toEqual([{ userText: command("p1"), ended: false }]);
  });

  it("keeps two turns with the same text as two turns", () => {
    const turns = parseTranscriptTurns(
      jsonl(
        user(command("r1")),
        assistant("end_turn", [text("one")]),
        stopSummary,
        user(command("r1")),
        assistant("end_turn", [text("two")]),
        stopSummary,
      ),
    );

    expect(turns.map((turn) => turn.lastAssistantText)).toEqual(["one", "two"]);
  });

  it("does not end a turn on tool use, nor start one on a tool result or the expanded command", () => {
    const turns = parseTranscriptTurns(
      jsonl(
        user(command("p1")),
        user([text("expanded command body")], { isMeta: true }),
        assistant("tool_use", [toolUse]),
        user(toolResult),
        assistant("end_turn", [text("DONE")]),
        stopSummary,
      ),
    );

    expect(turns).toEqual([{ userText: command("p1"), ended: true, lastAssistantText: "DONE" }]);
  });

  it("reads a user turn given as text blocks and skips malformed lines", () => {
    const turns = parseTranscriptTurns(
      jsonl(
        "{not json",
        user([text("Use the Agent tool")]),
        "",
        assistant("end_turn", [text("DONE")]),
        stopSummary,
      ),
    );

    expect(turns).toEqual([
      { userText: "Use the Agent tool", ended: true, lastAssistantText: "DONE" },
    ]);
  });
});
