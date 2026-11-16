import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ClaudeNarrator } from "../../src/adapters/claude/claude-narrator.js";
import { nodeStatus } from "../../src/core/run/run-events.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import * as builders from "../fixtures/flow-builders.js";
import { liveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo } from "../fixtures/tmp-repo.js";
import { useTempClaudeConfig } from "../fixtures/claude-config.js";

const digest = [
  "Run of blueprint Fix and verify, version 3.",
  "Stage 1, Fix the login bug: done.",
  "Stage 2, Run the test suite: failed. Reason: tests did not pass in CI.",
].join("\n");

const runDeadlineMs = 120_000;
const storyDeadlineMs = 150_000;

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("run story, with real claude on haiku", () => {
  useTempClaudeConfig();
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("narrator: names the failed stage, reports a cost, and runs with no tools", async () => {
    const { text, cost } = await new ClaudeNarrator({ home }).narrate(
      digest,
      new AbortController().signal,
    );

    expect(text).toMatch(/run the test suite/i);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(0);
  }, 150_000);

  it(
    "run: a run whose second stage fails gets a story naming that stage",
    { timeout: runDeadlineMs + storyDeadlineMs + 60_000 },
    async () => {
      const repo = await createTmpRepo({ commit: true });
      const live = liveEngine({
        home,
        repo: repo.path,
        sessionName: `fd-live-run-story-${process.pid}`,
        waiter: new FakeWaiter([{ decision: "reject", reason: "not wanted" }]),
        narrator: new ClaudeNarrator({ home }),
      });
      onTestFinished(async () => {
        await live.cleanup();
        await repo.cleanup();
      });
      const parsed = builders.flow(
        [
          builders.trigger("t"),
          {
            ...builders.agent("p1", { settings: { instructions: "Say hi.", model: "haiku" } }),
            label: "Say hello",
          },
          { ...builders.gate("g1"), label: "Review the greeting" },
          builders.output("stop"),
        ],
        [
          builders.thenWire("t", "p1"),
          builders.thenWire("p1", "g1"),
          builders.thenWire("g1", "stop"),
        ],
      );
      const flow = { ...parsed, session: { ...parsed.session, model: "haiku" } };
      const { buildId } = await live.saveAndBuild(flow, { name: "live-run-story" });

      const runId = await live.runBuild(buildId);
      const status = await live.waitForRunEnd(runId, runDeadlineMs);
      const events = live.stores.runs.events(runId);
      const report = events.map((event) => JSON.stringify(event)).join("\n");

      expect(status, report).toBe("failed");
      expect(nodeStatus(events.filter((event) => event.nodeId === "p1")), report).toBe("done");
      expect(nodeStatus(events.filter((event) => event.nodeId === "g1")), report).toBe("failed");
      const story = await vi.waitFor(
        () => {
          const told = live.stores.runs.latestRunStory(runId);
          if (told === undefined) throw new Error("no story yet");
          return told;
        },
        { timeout: storyDeadlineMs, interval: 500 },
      );
      expect(story).toMatchObject({ runId, runStatus: "failed" });
      expect(story.text).toMatch(/review the greeting/i);
      expect(Number.isFinite(story.cost)).toBe(true);
      expect(story.cost).toBeGreaterThanOrEqual(0);
    },
  );
});
