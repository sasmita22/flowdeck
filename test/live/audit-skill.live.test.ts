import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { registry } from "../../src/core/nodes/registry.js";
import { killTmuxServer, readLines, removeClaudeSessions, sleep } from "../fixtures/live-claude.js";
import { paneText, transcriptTail } from "../fixtures/live-evidence.js";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const blueprintSkill = "kit-blueprint/skills/blueprint/SKILL.md";
const plantedType = "relay";
const plantedRow =
  "| `relay`    | Passes its input on to the next node unchanged         | none | in `in`, out `out` (then) |";
const turnTimeoutMs = 360_000;
const prompt = [
  "Use the audit-ai-guidelines skill.",
  `Run only its staleness check, on ${blueprintSkill} only.`,
  'Write each stale claim to audit-out.md as "said X, true is Y".',
].join(" ");

type Block = { type?: string; name?: string; input?: { skill?: string } };
type Entry = {
  message?: { role?: string; model?: string; stop_reason?: string; content?: unknown };
};

const assistantMessages = async (transcript: string | undefined) =>
  transcript === undefined
    ? []
    : (await readLines<Entry>(transcript)).flatMap((entry) =>
        entry.message?.role === "assistant" && typeof entry.message.model === "string"
          ? [entry.message]
          : [],
      );

const blocksOf = (messages: Entry["message"][]): Block[] =>
  messages.flatMap((message) =>
    Array.isArray(message?.content) ? (message.content as Block[]) : [],
  );

async function copyOfWorkingTree(into: string, scratch: string): Promise<void> {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  await run("git", ["read-tree", "HEAD"], { cwd: repoRoot, env });
  await run("git", ["add", "--all"], { cwd: repoRoot, env });
  const tree = (await run("git", ["write-tree"], { cwd: repoRoot, env })).stdout.trim();
  const archive = join(scratch, "copy.tar");
  await run("git", ["archive", `--output=${archive}`, tree], { cwd: repoRoot });
  await mkdir(into, { recursive: true });
  await run("tar", ["-xf", archive, "-C", into]);
}

async function plantRelayRow(copy: string): Promise<void> {
  const path = join(copy, blueprintSkill);
  const lines = (await readFile(path, "utf8")).split("\n");
  const outputRow = lines.findIndex((line) => line.startsWith("| `output`"));
  if (outputRow === -1) throw new Error(`no output row in ${blueprintSkill}`);
  lines.splice(outputRow + 1, 0, plantedRow);
  await writeFile(path, lines.join("\n"));
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("the audit-ai-guidelines skill", () => {
  const sessionName = `fd-live-audit-${process.pid}`;
  const sessions = new TmuxSessionHost({ socketName: sessionName });
  const claude = new ClaudeCli({ sessions });
  const sessionId = randomUUID();
  let scratch: string;
  let copy: string;

  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "fd-audit-")));
    copy = join(scratch, "repo");
  });

  afterEach(async () => {
    await killTmuxServer(sessionName);
    await removeClaudeSessions(copy, [sessionId]);
    await rm(scratch, { recursive: true, force: true });
  }, 60_000);

  it(
    "finds a node type the blueprint skill names that the registry does not have",
    { timeout: turnTimeoutMs + 120_000 },
    async () => {
      expect(Object.keys(registry)).not.toContain(plantedType);
      await copyOfWorkingTree(copy, scratch);
      await plantRelayRow(copy);
      expect(await readFile(join(copy, blueprintSkill), "utf8")).toContain(plantedRow);

      const settingsPath = join(scratch, "settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({
          permissions: {
            allow: ["Skill", "Read", "Glob", "Grep", "Write", "Edit"],
            deny: ["Bash", "WebFetch", "WebSearch", "NotebookEdit"],
            defaultMode: "acceptEdits",
          },
        }),
      );
      await claude.start(
        sessionName,
        copy,
        { sessionId, model: "haiku" },
        { settingsPath, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } },
      );
      await claude.waitUntilReady(sessionName);
      await claude.sendPrompt(sessionName, prompt);

      const transcript = async () => claude.findTranscript(sessionId);
      const deadline = Date.now() + turnTimeoutMs;
      while ((await assistantMessages(await transcript())).at(-1)?.stop_reason !== "end_turn") {
        if (Date.now() >= deadline) break;
        await sleep(2000);
      }

      const messages = await assistantMessages(await transcript());
      const path = await transcript();
      const report = await readFile(join(copy, "audit-out.md"), "utf8").catch(() => undefined);
      console.log(
        [
          `pane:\n${await paneText(sessionName, sessionName)}`,
          `transcript tail:\n${(path === undefined ? [] : await transcriptTail(path, 60)).join("\n")}`,
          `audit-out.md:\n${report ?? "(missing)"}`,
          `models: ${[...new Set(messages.map((message) => message?.model))].join(", ")}`,
        ].join("\n\n"),
      );

      expect(messages.at(-1)?.stop_reason, "the turn ended").toBe("end_turn");
      expect(messages.map((message) => message?.model)).toEqual(
        messages.map(() => expect.stringMatching(/haiku/)),
      );
      expect(
        blocksOf(messages).some(
          (block) =>
            block.type === "tool_use" &&
            block.name === "Skill" &&
            /audit-ai-guidelines/.test(block.input?.skill ?? ""),
        ),
        "the session loaded audit-ai-guidelines",
      ).toBe(true);
      expect(report, "audit-out.md was written").toBeDefined();
      expect(report).toMatch(new RegExp(`\\b${plantedType}\\b`, "i"));
    },
  );
});
