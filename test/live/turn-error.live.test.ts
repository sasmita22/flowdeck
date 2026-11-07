import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeStatus } from "../../src/core/run/run-events.js";
import * as builders from "../fixtures/flow-builders.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const buildName = "live-turn-error";
const runDeadlineMs = 60_000;
const notLoggedIn = "Not logged in · Please run /login";
const loggedInVars = [
  "USER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "TMUX",
  "TMUX_PANE",
] as const;

function logOut(): () => void {
  const saved = loggedInVars.map((name) => [name, process.env[name]] as const);
  for (const name of loggedInVars) Reflect.deleteProperty(process.env, name);
  return () => {
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  };
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a turn that errors, with real claude", () => {
  const sessionName = `fd-live-turn-error-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let logIn: (() => void) | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
    logIn = undefined;
  });

  afterEach(async () => {
    logIn?.();
    try {
      const { stdout } = await run("tmux", [
        "-L",
        sessionName,
        "capture-pane",
        "-p",
        "-t",
        `=${sessionName}:`,
      ]);
      console.error(`pane of ${sessionName} before cleanup:\n${stdout}`);
    } catch (error) {
      console.error(`no pane of ${sessionName} to capture: ${String(error)}`);
    }
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "fails a logged-out session's Prompt node with its message, and the run ends failed",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const parsed = builders.flow(
        [builders.trigger("t"), builders.prompt("p1", { settings: { instructions: "Say hi." } })],
        [builders.thenWire("t", "p1")],
      );
      const flow = { ...parsed, session: { ...parsed.session, model: "haiku" } };
      const live = liveEngine({ home, repo: repo.path, sessionName });
      engine = live;
      const { buildId } = await live.saveAndBuild(flow, { name: buildName });

      logIn = logOut();
      const runId = await live.runBuild(buildId);
      const status = await live.waitForRunEnd(runId, runDeadlineMs);
      logIn();
      logIn = undefined;

      const p1Events = live.stores.runs.events(runId).filter((event) => event.nodeId === "p1");
      const progress = p1Events
        .filter(
          (event) => event.kind === "sent" || event.kind === "failed" || event.kind === "done",
        )
        .map((event) => event.kind);
      const report = `status ${status}\np1 events:\n${p1Events.map((event) => JSON.stringify(event)).join("\n")}`;

      expect(status, report).toBe("failed");
      expect(progress, report).toEqual(["sent", "failed"]);
      expect(live.stores.runs.listRuns().map((record) => record.status)).toEqual(["failed"]);
      expect(nodeStatus(p1Events)).toBe("failed");
      expect(p1Events.at(-1)).toMatchObject({
        kind: "failed",
        payload: { message: `p1 failed: ${notLoggedIn}` },
      });
    },
  );
});
