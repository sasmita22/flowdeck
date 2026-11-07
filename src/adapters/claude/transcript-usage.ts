import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UsageEntry, UsageSource } from "../../ports/usage-source.js";
import { hasCode } from "./claude-cli.js";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

type Block = { type?: string; text?: unknown };

type Line = {
  type?: string;
  subtype?: string;
  timestamp?: unknown;
  message?: { id?: string; model?: string; content?: unknown; usage?: Usage };
};

async function readOrNothing<T>(read: () => Promise<T>, nothing: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return nothing;
    throw error;
  }
}

function parse(line: string): Line | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Line) : undefined;
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = (content as Block[]).flatMap((block) =>
    block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  return texts.length === 0 ? undefined : texts.join("\n");
}

function entryOf(line: Line | undefined): UsageEntry | undefined {
  const message = line?.type === "assistant" ? line.message : undefined;
  const usage = message?.usage;
  if (message === undefined || usage === undefined) return undefined;
  const split = usage.cache_creation;
  const text = textOf(message.content);
  const at = typeof line?.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  return {
    messageId: message.id ?? "",
    model: message.model ?? "",
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWrite5mTokens:
      split === undefined
        ? (usage.cache_creation_input_tokens ?? 0)
        : (split.ephemeral_5m_input_tokens ?? 0),
    cacheWrite1hTokens: split?.ephemeral_1h_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    ...(text === undefined ? {} : { text }),
    ...(Number.isNaN(at) ? {} : { at }),
  };
}

const entriesIn = (jsonl: string): UsageEntry[] =>
  jsonl.split("\n").flatMap((line) => entryOf(parse(line)) ?? []);

type Transcript = { jsonl: string; tags: Pick<UsageEntry, "agentType" | "toolUseId"> };

function tagsIn(meta: string | undefined): Transcript["tags"] {
  const parsed =
    meta === undefined
      ? undefined
      : (parse(meta) as { agentType?: unknown; toolUseId?: unknown } | undefined);
  return {
    ...(typeof parsed?.agentType === "string" ? { agentType: parsed.agentType } : {}),
    ...(typeof parsed?.toolUseId === "string" ? { toolUseId: parsed.toolUseId } : {}),
  };
}

export class TranscriptUsage implements UsageSource {
  private readonly findTranscript: (sessionId: string) => Promise<string | undefined>;

  constructor(options: { findTranscript: (sessionId: string) => Promise<string | undefined> }) {
    this.findTranscript = options.findTranscript;
  }

  async entries(sessionId: string): Promise<UsageEntry[]> {
    if (sessionId === "") return [];
    const transcript = await this.findTranscript(sessionId);
    if (transcript === undefined) return [];
    return (await this.transcripts(transcript, sessionId)).flatMap(({ jsonl, tags }) =>
      entriesIn(jsonl).map((entry) => ({ ...entry, ...tags })),
    );
  }

  async compactions(sessionId: string): Promise<number> {
    if (sessionId === "") return 0;
    const transcript = await this.findTranscript(sessionId);
    if (transcript === undefined) return 0;
    const main = await readOrNothing(() => readFile(transcript, "utf8"), "");
    return main.split("\n").filter((line) => {
      const parsed = parse(line);
      return parsed?.type === "system" && parsed.subtype === "compact_boundary";
    }).length;
  }

  private async transcripts(transcript: string, sessionId: string): Promise<Transcript[]> {
    const read = (file: string) => readOrNothing(() => readFile(file, "utf8"), undefined);
    const main = await read(transcript);
    if (main === undefined) return [];
    const subagents = join(dirname(transcript), sessionId, "subagents");
    const names = (await readOrNothing(() => readdir(subagents), [])).filter((name) =>
      name.endsWith(".jsonl"),
    );
    const others = await Promise.all(
      names.map(async (name): Promise<Transcript | undefined> => {
        const jsonl = await read(join(subagents, name));
        if (jsonl === undefined) return undefined;
        const meta = await read(join(subagents, name.replace(/\.jsonl$/, ".meta.json")));
        return { jsonl, tags: tagsIn(meta) };
      }),
    );
    return [{ jsonl: main, tags: {} }, ...others.flatMap((other) => other ?? [])];
  }
}
