import type { TranscriptTurn } from "../../core/run/resume.js";

type Block = { type?: string; text?: string };

type Entry = {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  message?: { content?: string | Block[]; stop_reason?: string | null };
};

function parse(line: string): Entry | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === "object" && entry !== null ? (entry as Entry) : undefined;
  } catch {
    return undefined;
  }
}

function textOf(content: string | Block[] | undefined): string | undefined {
  if (typeof content === "string") return content;
  const texts = (content ?? []).filter((block) => block.type === "text");
  return texts.length === 0 ? undefined : texts.map((block) => block.text ?? "").join("\n");
}

export function parseTranscriptTurns(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | undefined;
  for (const line of jsonl.split("\n")) {
    const entry = parse(line);
    if (entry === undefined) continue;
    if (entry.type === "user" && entry.isMeta !== true) {
      const userText = textOf(entry.message?.content);
      if (userText !== undefined) {
        current = { userText, ended: false };
        turns.push(current);
      }
    }
    if (current === undefined || current.ended) continue;
    if (entry.type === "assistant") {
      const reply = textOf(entry.message?.content);
      if (reply !== undefined) current.lastAssistantText = reply;
    }
    if (entry.type === "system" && entry.subtype === "stop_hook_summary") current.ended = true;
  }
  return turns.map((turn) => (turn.ended ? turn : { userText: turn.userText, ended: false }));
}
