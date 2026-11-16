import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CostReport } from "../../src/core/run/cost.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import type { HumanWaiter, WaitRequest } from "../../src/core/run/wait.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const runDeadlineMs = 300_000;

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function twoRoundLoop() {
  return parseFlow({
    nodes: [
      { id: "t", label: "Start", type: "trigger", position: at(0), settings: {} },
      {
        id: "l1",
        label: "Twice",
        type: "loop",
        position: at(1),
        settings: { condition: "1 equals 2", cap: 2, onCap: "ask" },
      },
      {
        id: "a",
        label: "Say ok",
        type: "agent",
        position: at(2),
        parent: "l1",
        settings: { role: "", instructions: "Reply ok.", model: "haiku", tools: [] },
      },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(3),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [then("t", "l1"), then("l1", "o")],
    session: {
      name: "main",
      buildConfig: { base: "main", variables: [] },
      model: "haiku",
      allowedTools: [],
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

async function loggedInConfig(root: string): Promise<string> {
  const dir = join(root, ".claude");
  await mkdir(dir, { recursive: true });
  await copyFile(join(homedir(), ".claude", "settings.json"), join(dir, "settings.json"));
  await copyFile(join(homedir(), ".claude.json"), join(dir, ".claude.json"));
  return dir;
}

const listing = (dir: string) => readdir(dir, { recursive: true }).catch(() => [] as string[]);

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("cost per round with real claude", () => {
  const sessionName = `fd-live-rcost-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let configRoot: string;
  let claudeTmp: string | undefined;
  const savedEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  };

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
    configRoot = await realpath(await mkdtemp(join(tmpdir(), "fd-cfg-")));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
    claudeTmp = undefined;
  });

  afterEach(async () => {
    await engine?.cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (claudeTmp !== undefined) await rm(claudeTmp, { recursive: true, force: true });
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
    await rm(configRoot, { recursive: true, force: true });
  }, 60_000);

  it(
    "charges a Loop forced to two rounds once per round, the rounds adding up to the node",
    { timeout: runDeadlineMs + 120_000 },
    async () => {
      const configDir = await loggedInConfig(configRoot);
      Object.assign(process.env, {
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      });
      const questions: WaitRequest[] = [];
      const waiter: HumanWaiter = {
        wait: async (request) => {
          questions.push(request);
          if (request.kind === "ask" && request.options.includes("continue")) {
            return { decision: "answer", answer: "continue" };
          }
          if (request.kind === "ask" && request.options.includes("again")) {
            return { decision: "answer", answer: "again" };
          }
          return { decision: "reject", reason: "no question expected" };
        },
      };
      engine = liveEngine({
        home,
        repo: repo.path,
        sessionName,
        waiter,
        transcriptsHome: configRoot,
      });

      const built = await engine.saveAndBuild(twoRoundLoop(), { name: "live-round-cost" });
      const slug = (await realpath(built.workFolder)).replace(/[^a-zA-Z0-9]/g, "-");
      claudeTmp = join("/private/tmp", `claude-${userInfo().uid}`, slug);
      const runId = await engine.runBuild(built.buildId);
      const status = await engine.waitForRunEnd(runId, runDeadlineMs);

      const events = engine.stores.runs.events(runId);
      const rounds = events
        .filter((event) => event.nodeId === "l1" && event.kind === "round")
        .map((event) => (event.kind === "round" ? event.payload.round : undefined));
      const usage = events.flatMap((event) =>
        event.nodeId === "a" && event.kind === "usage"
          ? [{ round: event.payload.round, tokens: event.tokens, cost: event.cost }]
          : [],
      );
      const costOfRound = (round: number) =>
        usage.filter((line) => line.round === round).reduce((sum, line) => sum + line.cost, 0);
      const report = await engine.ask<CostReport>("run-cost", { runId });
      const line = report.nodes.find((node) => node.nodeId === "a");
      console.log(
        [
          `status: ${status}`,
          `questions: ${JSON.stringify(questions)}`,
          `events:\n${events.map((e) => `${e.seq} ${e.nodeId} ${e.kind} ${JSON.stringify("payload" in e ? e.payload : "")}`).join("\n")}`,
          `usage of a: ${JSON.stringify(usage)}`,
          `cost line of a: ${JSON.stringify(line)}`,
          `transcripts in temp config: ${JSON.stringify(await listing(join(configDir, "projects")))}`,
        ].join("\n"),
      );

      expect(status).toBe("done");
      expect(rounds).toEqual([1, 2]);
      expect(usage.length, "no usage recorded for the body node").toBeGreaterThan(0);
      expect([...new Set(usage.map((entry) => entry.round))].sort()).toEqual([1, 2]);
      expect(costOfRound(1)).toBeGreaterThan(0);
      expect(costOfRound(2)).toBeGreaterThan(0);
      expect(line?.rounds?.map((round) => round.round)).toEqual([1, 2]);
      expect(line?.rounds?.[0]?.cost).toBeCloseTo(costOfRound(1), 12);
      expect(line?.rounds?.[1]?.cost).toBeCloseTo(costOfRound(2), 12);
      expect(costOfRound(1) + costOfRound(2)).toBeCloseTo(line?.cost ?? Number.NaN, 12);
    },
  );
});
