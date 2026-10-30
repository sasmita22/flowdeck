import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../../src/adapters/claude/claude-cli.js";
import { TranscriptUsage } from "../../../src/adapters/claude/transcript-usage.js";
import type { UsageEntry } from "../../../src/ports/usage-source.js";
import { FakeSessionHost } from "../../fakes/fake-session-host.js";

const sessionId = "917038c7-c9a6-4da1-8e39-724b55074ba5";

const assistant = (id: string, model: string, usage: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    sessionId,
    message: { id, model, role: "assistant", content: [], usage },
  });

const user = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });

const jsonl = (...lines: string[]) => `${lines.join("\n")}\n`;

const entry = (messageId: string, model: string, tokens: Partial<UsageEntry>): UsageEntry => ({
  messageId,
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  ...tokens,
});

describe("TranscriptUsage", () => {
  let home: string;
  let folder: string;
  let usage: TranscriptUsage;

  const usageUnder = (homeDir: string) => {
    const claude = new ClaudeCli({ sessions: new FakeSessionHost(), homeDir });
    return new TranscriptUsage({ findTranscript: (id) => claude.findTranscript(id) });
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-usage-"));
    folder = join(home, ".claude", "projects", "-private-tmp-repo");
    await mkdir(folder, { recursive: true });
    usage = usageUnder(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const writeMain = (text: string) => writeFile(join(folder, `${sessionId}.jsonl`), text);

  async function writeSubagent(name: string, text: string): Promise<void> {
    const subagents = join(folder, sessionId, "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(join(subagents, name), text);
  }

  it("reads the usage of every assistant line in the main and subagent transcripts", async () => {
    await writeMain(
      jsonl(
        user,
        assistant("msg_main", "claude-haiku-5-5", {
          input_tokens: 2,
          output_tokens: 98,
          cache_creation_input_tokens: 22555,
          cache_read_input_tokens: 27369,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 22555 },
        }),
      ),
    );
    await writeSubagent(
      "agent-a1.jsonl",
      jsonl(
        assistant("msg_sub", "claude-sonnet-5-5", {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 0 },
        }),
      ),
    );

    const entries = await usage.entries(sessionId);

    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        entry("msg_main", "claude-haiku-5-5", {
          inputTokens: 2,
          outputTokens: 98,
          cacheWrite1hTokens: 22555,
          cacheReadTokens: 27369,
        }),
        entry("msg_sub", "claude-sonnet-5-5", {
          inputTokens: 10,
          outputTokens: 20,
          cacheWrite5mTokens: 7,
          cacheReadTokens: 3,
        }),
      ]),
    );
  });

  it("counts a bare cache_creation_input_tokens as a 5 minute write", async () => {
    await writeMain(
      jsonl(
        assistant("msg_1", "claude-opus-5-5", {
          input_tokens: 5,
          output_tokens: 6,
          cache_creation_input_tokens: 30,
        }),
      ),
    );

    expect(await usage.entries(sessionId)).toEqual([
      entry("msg_1", "claude-opus-5-5", {
        inputTokens: 5,
        outputTokens: 6,
        cacheWrite5mTokens: 30,
      }),
    ]);
  });

  it("skips malformed lines and assistant lines without usage", async () => {
    await writeMain(
      jsonl(
        "not json {",
        "null",
        "[1]",
        JSON.stringify({
          type: "assistant",
          message: { id: "msg_none", model: "claude-opus-5-5" },
        }),
        assistant("msg_ok", "claude-opus-5-5", { input_tokens: 1, output_tokens: 1 }),
      ) + '{"type":"assistant","message":{"usage"',
    );

    expect(await usage.entries(sessionId)).toEqual([
      entry("msg_ok", "claude-opus-5-5", { inputTokens: 1, outputTokens: 1 }),
    ]);
  });

  it("carries the text of an assistant line, joining its text blocks", async () => {
    const line = (content: unknown[]) =>
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-haiku-5-5",
          content,
          usage: { output_tokens: 4 },
        },
      });
    await writeMain(
      jsonl(
        line([{ type: "thinking", thinking: "hmm" }]),
        line([
          { type: "text", text: "first" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
          { type: "text", text: "second" },
        ]),
      ),
    );

    expect(await usage.entries(sessionId)).toEqual([
      entry("msg_1", "claude-haiku-5-5", { outputTokens: 4 }),
      entry("msg_1", "claude-haiku-5-5", { outputTokens: 4, text: "first\nsecond" }),
    ]);
  });

  it("gives no entries for an empty session id", async () => {
    await writeMain(jsonl(assistant("msg_1", "claude-opus-5-5", { input_tokens: 1 })));

    expect(await usage.entries("")).toEqual([]);
  });

  it("gives no entries for a session with no transcript", async () => {
    expect(await usage.entries("11111111-2222-3333-4444-555555555555")).toEqual([]);
  });

  it("gives no entries when the projects folder is missing", async () => {
    const missing = usageUnder(join(home, "absent"));

    expect(await missing.entries(sessionId)).toEqual([]);
  });
});
