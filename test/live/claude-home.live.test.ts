import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeLeftovers } from "../../scripts/claude-config.js";
import { nodeStatus } from "../../src/core/run/run-events.js";
import * as builders from "../fixtures/flow-builders.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";
import { useTempClaudeConfig } from "../fixtures/claude-config.js";

const runDeadlineMs = 120_000;

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a live run and the user's Claude home", () => {
  useTempClaudeConfig();
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let claudeTmp: string | undefined;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
    claudeTmp = undefined;
  });

  afterEach(async () => {
    await engine?.cleanup();
    if (claudeTmp !== undefined) await rm(claudeTmp, { recursive: true, force: true });
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "leaves no project folder or .claude.json key naming its temp paths",
    { timeout: runDeadlineMs + 120_000 },
    async () => {
      engine = liveEngine({
        home,
        repo: repo.path,
        sessionName: `fd-live-home-${process.pid}`,
      });
      const parsed = builders.flow(
        [
          builders.trigger("t"),
          builders.agent("p1", { settings: { instructions: "Reply ok.", model: "haiku" } }),
          builders.output("stop"),
        ],
        [builders.thenWire("t", "p1"), builders.thenWire("p1", "stop")],
      );
      const flow = { ...parsed, session: { ...parsed.session, model: "haiku" } };
      const built = await engine.saveAndBuild(flow, { name: "live-claude-home" });
      claudeTmp = join(
        "/private/tmp",
        `claude-${userInfo().uid}`,
        built.workFolder.replace(/[^a-zA-Z0-9]/g, "-"),
      );

      const runId = await engine.runBuild(built.buildId);
      const status = await engine.waitForRunEnd(runId, runDeadlineMs);
      const events = engine.stores.runs.events(runId);
      const report = events.map((event) => JSON.stringify(event)).join("\n");

      expect(status, report).toBe("done");
      expect(nodeStatus(events.filter((event) => event.nodeId === "p1")), report).toBe("done");
      expect(await claudeLeftovers({ roots: [home, repo.path] })).toEqual([]);
    },
  );
});
