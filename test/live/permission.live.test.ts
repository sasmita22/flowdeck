import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { CliWaiter } from "../../src/cli/cli-waiter.js";
import { realDeps, runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import { transcriptTail } from "../fixtures/live-evidence.js";
import {
  killTmuxServer,
  readLines,
  removeClaudeSessions,
  sleep,
  tokenResults,
  type ContentBlock,
  type TranscriptEntry,
} from "../fixtures/live-claude.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const questionWithinMs = 120_000;
const unattendedHoldMs = 5000;

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function liveFlow(instructions: string) {
  return parseFlow({
    nodes: [
      {
        id: "t",
        label: "Start",
        type: "trigger",
        position: at(0),
        settings: { inputs: [], flags: {} },
      },
      { id: "p1", label: "Run", type: "prompt", position: at(1), settings: { instructions } },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(2),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [then("t", "p1"), then("p1", "o")],
    session: {
      name: "main",
      workingFolder: { kind: "worktree", branch: "main" },
      model: "haiku",
      allowedTools: ["Read", "Edit"],
      permissionMode: "default",
      connectors: [],
    },
  });
}

const transcriptEntries = async (path: string | undefined): Promise<TranscriptEntry[]> =>
  path === undefined ? [] : readLines<TranscriptEntry>(path);

function hookDecisions(entries: TranscriptEntry[]): string[] {
  return entries
    .map((entry) => entry.attachment)
    .filter((a) => a?.type === "hook_permission_decision" && a.hookEvent === "PermissionRequest")
    .map((a) => a?.decision ?? "");
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("permission requests with real claude", () => {
  const sessionName = `fd-live-perm-${process.pid}`;
  const claude = new ClaudeCli({ sessions: new TmuxSessionHost() });
  let home: string;
  let repo: TmpRepo;
  let sessionIds: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    sessionIds = [];
  });

  afterEach(async () => {
    await killTmuxServer(sessionName);
    await removeClaudeSessions(repo.path, sessionIds);
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "holds Bash outside the allowed tools until the question is approved, then runs it",
    { timeout: 420_000 },
    async () => {
      const token = `fd-perm-${randomUUID().slice(0, 8)}`;

      const built = await build(
        liveFlow(
          `Run the Bash command \`node -e "console.log('${token}')"\` and reply with its output.`,
        ),
        {
          fs: new NodeFileSystem(),
          home,
          hooks: { nodePath: process.execPath, hookScriptPath },
        },
      );
      if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);

      const transcript = async () => {
        const sessionId = sessionIds[0];
        return sessionId === undefined ? undefined : claude.findTranscript(sessionId);
      };
      const results = async () => tokenResults(await transcriptEntries(await transcript()), token);

      const questions: string[] = [];
      let atQuestion: ContentBlock[] | undefined;
      let afterHold: ContentBlock[] | undefined;
      let asked: () => void = () => {};
      const question = new Promise<void>((resolve) => (asked = resolve));
      const waiter = new CliWaiter({
        write: (text) => {
          questions.push(text);
          asked();
        },
        readLine: async () => {
          atQuestion = await results();
          await sleep(unattendedHoldMs);
          afterHold = await results();
          return "approve";
        },
      });

      const real = realDeps();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const deps: CliDeps = {
        ...real,
        env: { ...process.env, FLOWDECK_HOME: home },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        waiter,
        openSession: async (options) => {
          const opened = await real.openSession(options);
          sessionIds.push(opened.sessionId);
          return opened;
        },
      };

      const exit = runCli(
        ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
        deps,
      );
      const noQuestion = sleep(questionWithinMs).then(() => "none" as const);
      const first = await Promise.race([question.then(() => "asked" as const), noQuestion]);
      if (first === "none") {
        const path = await transcript();
        const tail = path === undefined ? [] : await transcriptTail(path);
        console.log(`no question; stdout:\n${stdout.join("\n")}\ntranscript:\n${tail.join("\n")}`);
      }
      expect(first, `a permission question within ${questionWithinMs} ms`).toBe("asked");

      const code = await exit;
      const entries = await transcriptEntries(await transcript());
      console.log(
        [
          `exit: ${code}`,
          `questions: ${JSON.stringify(questions)}`,
          `stdout:\n${stdout.join("\n")}`,
          `stderr:\n${stderr.join("\n")}`,
          `hook decisions: ${JSON.stringify(hookDecisions(entries))}`,
        ].join("\n"),
      );

      expect(questions).toHaveLength(1);
      expect(questions[0]).toContain(`p1 permission: Allow Bash: node -e`);
      expect(questions[0]).toContain(token);
      expect(atQuestion, "Bash ran before the question was answered").toEqual([]);
      expect(afterHold, "Bash ran unattended").toEqual([]);
      expect(code).toBe(0);
      expect(stdout).toContain("p1 done");
      expect(tokenResults(entries, token).length).toBeGreaterThan(0);
      expect(hookDecisions(entries)).toEqual(["allow"]);
    },
  );
});
