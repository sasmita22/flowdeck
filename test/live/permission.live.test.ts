import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import type { HumanWaiter, WaitRequest } from "../../src/core/run/wait.js";
import { transcriptTail } from "../fixtures/live-evidence.js";
import {
  readLines,
  sleep,
  tokenResults,
  type ContentBlock,
  type TranscriptEntry,
} from "../fixtures/live-claude.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const buildName = "live-permission";
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
        settings: {},
      },
      {
        id: "p1",
        label: "Run",
        type: "agent",
        position: at(1),
        settings: { role: "", instructions, model: "haiku", tools: [] },
      },
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
      buildConfig: { base: "main", variables: [] },
      model: "haiku",
      allowedTools: ["Read", "Edit"],
      permissionMode: "default",
      connectors: [],
    },
  });
}

async function transcriptEntries(path: string | undefined): Promise<TranscriptEntry[]> {
  if (path === undefined) return [];
  const subagents = join(path.replace(/\.jsonl$/, ""), "subagents");
  const names = await readdir(subagents).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const files = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(subagents, name));
  return (
    await Promise.all([path, ...files].map((file) => readLines<TranscriptEntry>(file)))
  ).flat();
}

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
  let engine: LiveEngine | undefined;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
  });

  afterEach(async () => {
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "holds Bash outside the allowed tools until the question is approved, then runs it",
    { timeout: 420_000 },
    async () => {
      const token = `fd-perm-${randomUUID().slice(0, 8)}`;

      const transcript = async () => {
        const sessionId = engine?.sessionIds[0];
        return sessionId === undefined ? undefined : claude.findTranscript(sessionId);
      };
      const results = async () => tokenResults(await transcriptEntries(await transcript()), token);

      const questions: WaitRequest[] = [];
      let atQuestion: ContentBlock[] | undefined;
      let afterHold: ContentBlock[] | undefined;
      let asked: () => void = () => {};
      const question = new Promise<void>((resolve) => (asked = resolve));
      const waiter: HumanWaiter = {
        wait: async (request) => {
          questions.push(request);
          asked();
          atQuestion = await results();
          await sleep(unattendedHoldMs);
          afterHold = await results();
          return { decision: "approve" };
        },
      };

      engine = liveEngine({ home, repo: repo.path, sessionName, waiter });
      const built = await engine.saveAndBuild(
        liveFlow(
          `Run the Bash command \`node -e "console.log('${token}')"\` and reply with its output.`,
        ),
        { name: buildName },
      );

      const runId = await engine.runBuild(built.buildId);
      const ended = engine.waitForRunEnd(runId, 360_000);
      const noQuestion = sleep(questionWithinMs).then(() => "none" as const);
      const first = await Promise.race([question.then(() => "asked" as const), noQuestion]);
      if (first === "none") {
        const path = await transcript();
        const tail = path === undefined ? [] : await transcriptTail(path);
        console.log(`no question; transcript:\n${tail.join("\n")}`);
      }
      expect(first, `a permission question within ${questionWithinMs} ms`).toBe("asked");

      const status = await ended;
      const events = engine.stores.runs.events(runId);
      const entries = await transcriptEntries(await transcript());
      console.log(
        [
          `status: ${status}`,
          `questions: ${JSON.stringify(questions)}`,
          `run events:\n${events.map((event) => `${event.nodeId} ${event.kind}`).join("\n")}`,
          `hook decisions: ${JSON.stringify(hookDecisions(entries))}`,
        ].join("\n"),
      );

      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({ nodeId: "p1", kind: "permission", tool: "Bash" });
      const input = questions[0]?.kind === "permission" ? questions[0].input : "";
      expect(input).toMatch(/^node -e/);
      expect(input).toContain(token);
      expect(atQuestion, "Bash ran before the question was answered").toEqual([]);
      expect(afterHold, "Bash ran unattended").toEqual([]);
      expect(status).toBe("done");
      expect(events).toContainEqual(expect.objectContaining({ nodeId: "p1", kind: "done" }));
      expect(tokenResults(entries, token).length).toBeGreaterThan(0);
      expect(hookDecisions(entries)).toEqual(["allow"]);
    },
  );
});
