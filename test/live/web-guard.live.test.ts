import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { blueprintSessionSettings } from "../../src/core/compiler/blueprint-session.js";
import { shellQuote } from "../../src/core/compiler/hook-settings.js";
import { killTmuxServer, readLines, removeClaudeSessions, sleep } from "../fixtures/live-claude.js";

const tmuxSocket = "fd-mt-web-guard";
const session = "fd-mt-web-guard";
const webGuardScript = fileURLToPath(new URL("../../bin/flowdeck-web-guard.ts", import.meta.url));
const outsideUrl = "https://docs.python.org/3/";
const githubUrl =
  "https://raw.githubusercontent.com/sasmita22/flowdeck/faf19d8c22e9e80a6fdf4e93c11654b3548e7ab5/e2e/fixtures/copy-flow/source-flow.md";
const guardReason =
  "Only github.com and raw.githubusercontent.com links or files on this machine can be read; docs.python.org is not allowed.";

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: { url?: string };
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type Line = { message?: { content?: unknown } };
type Fetch = { url: string; result: { text: string; isError: boolean } | undefined };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content ?? "");

async function transcriptFiles(main: string, sessionId: string): Promise<string[]> {
  const subagents = join(dirname(main), sessionId, "subagents");
  const files = (await readdir(subagents).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => join(subagents, file));
  return [main, ...files];
}

async function webFetches(cli: ClaudeCli, sessionId: string): Promise<Fetch[]> {
  const main = await cli.findTranscript(sessionId);
  if (main === undefined) return [];
  const blocks: Block[] = [];
  for (const file of await transcriptFiles(main, sessionId)) {
    for (const line of await readLines<Line>(file)) {
      const content = line.message?.content;
      if (Array.isArray(content)) blocks.push(...(content as Block[]));
    }
  }
  const results = new Map(
    blocks
      .filter((block) => block.type === "tool_result" && block.tool_use_id !== undefined)
      .map((block) => [
        block.tool_use_id,
        { text: textOf(block.content), isError: block.is_error === true },
      ]),
  );
  const calls = new Map(
    blocks
      .filter((block) => block.type === "tool_use" && block.name === "WebFetch")
      .map((block) => [block.id, block.input?.url ?? ""]),
  );
  return [...calls].map(([id, url]) => ({ url, result: results.get(id) }));
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("pane web guard", () => {
  const sessions = new TmuxSessionHost({ socketName: tmuxSocket });
  const cli = new ClaudeCli({ sessions });
  let folder: string | undefined;
  let sessionId: string | undefined;

  afterEach(async () => {
    if (await sessions.has(session)) await sessions.stop(session);
    await killTmuxServer(tmuxSocket);
    if (folder !== undefined) {
      if (sessionId !== undefined) await removeClaudeSessions(folder, [sessionId]);
      await rm(folder, { recursive: true, force: true });
    }
    folder = undefined;
    sessionId = undefined;
  }, 60_000);

  async function fetchesFor(url: string, deadlineMs: number): Promise<Fetch[]> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const done = (await webFetches(cli, sessionId ?? "")).filter(
        (fetch) => fetch.url.startsWith(url) && fetch.result !== undefined,
      );
      if (done.length > 0 || Date.now() >= deadline) return done;
      await sleep(1000);
    }
  }

  async function waitForIdle(deadlineMs: number): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    let idle = 0;
    while (idle < 3 && Date.now() < deadline) {
      idle = (await sessions.capture(session)).includes("esc to interrupt") ? 0 : idle + 1;
      await sleep(1000);
    }
  }

  async function ask(prompt: string, url: string): Promise<Fetch[]> {
    await cli.sendPrompt(session, prompt);
    await fetchesFor(url, 180_000);
    await waitForIdle(120_000);
    return fetchesFor(url, 0);
  }

  it(
    "denies a WebFetch outside GitHub with the guard's reason and fetches a raw GitHub file",
    { timeout: 420_000 },
    async () => {
      folder = await realpath(await mkdtemp(join(tmpdir(), "fd-mt-web-guard-")));
      sessionId = randomUUID();
      const settingsPath = join(folder, "settings.json");
      const mcpConfigPath = join(folder, "mcp.json");
      const settings = blueprintSessionSettings({
        home: folder,
        hookCommand: "true",
        webGuardCommand: [process.execPath, webGuardScript].map(shellQuote).join(" "),
      });
      await writeFile(settingsPath, JSON.stringify(settings));
      await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
      await cli.start(
        session,
        folder,
        { sessionId, model: "haiku" },
        { settingsPath, mcpConfigPath, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } },
      );
      await cli.waitUntilReady(session);

      const outside = await ask(`Fetch ${outsideUrl} with WebFetch.`, outsideUrl);
      const github = await ask(`Fetch ${githubUrl} with WebFetch.`, githubUrl);
      console.log(
        `pane:\n${await sessions.capture(session)}`,
        JSON.stringify(await webFetches(cli, sessionId), null, 2),
      );

      const fetched = (fetches: Fetch[]) =>
        fetches.filter((fetch) => fetch.result?.isError === false).map((fetch) => fetch.url);
      const texts = (fetches: Fetch[]) => fetches.map((fetch) => fetch.result?.text);
      expect(fetched(outside)).toEqual([]);
      expect(texts(outside)).toContainEqual(expect.stringContaining(guardReason));
      expect(fetched(github)).not.toEqual([]);
      expect(texts(github)).toContainEqual(expect.stringContaining("# Review flow"));
    },
  );
});
