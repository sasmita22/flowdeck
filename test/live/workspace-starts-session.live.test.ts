import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Flow } from "../../src/core/flow/schema.js";
import { nodeStatus } from "../../src/core/run/run-events.js";
import type { RunSessionRecord } from "../../src/core/run/store.js";
import type { HumanWaiter, WaitRequest } from "../../src/core/run/wait.js";
import { useTempClaudeConfig } from "../fixtures/claude-config.js";
import { agent, output, thenWire, trigger, workspaceFlow } from "../fixtures/flow-builders.js";
import { killTmuxServer, removeClaudeSessions } from "../fixtures/live-claude.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const model = "haiku";
const sessionNodes = ["session-1-start", "session-1-stop"];

function startsOneSession(repo: string): Flow {
  const built = workspaceFlow(
    [
      trigger("start"),
      agent("go", {
        settings: {
          model,
          instructions: "Run the app session's start command from CLAUDE.md, then run sleep 60.",
        },
      }),
      output("stop"),
    ],
    [thenWire("start", "go"), thenWire("go", "stop")],
    { buildModel: model, permissionMode: "bypassPermissions" },
    { session: { name: "app", repo, branch: "main", model } },
  );
  return {
    ...built,
    containers: built.containers.map((container) =>
      container.kind === "workspace" ? { ...container, model } : container,
    ),
  };
}

describe.skip("the workspace starts a session container", () => {
  useTempClaudeConfig();
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let sessions: RunSessionRecord[];

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
    sessions = [];
  });

  afterEach(async () => {
    for (const session of sessions) {
      await killTmuxServer(session.tmuxName);
      await removeClaudeSessions(session.cwd, [session.claudeSessionId]);
    }
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it("ends done with the started session's nodes done", { timeout: 600_000 }, async () => {
    const questions: WaitRequest[] = [];
    const waiter: HumanWaiter = {
      wait: async (request) => {
        questions.push(request);
        return { decision: "reject", reason: "no question expected" };
      },
    };
    engine = liveEngine({ home, repo: repo.path, waiter });
    const built = await engine.saveAndBuild(startsOneSession(repo.path), {
      name: "live-starts-session",
    });

    const runId = await engine.runBuild(built.buildId, { auto: true });
    const status = await engine.waitForRunEnd(runId, 480_000);
    sessions = engine.stores.runs.runSessions(runId);
    const started = sessions.find((session) => session.parent !== null);
    const owners = engine.stores.runs.nodeSessions(runId);
    const events = engine.stores.runs.events(runId);

    expect(status).toBe("done");
    expect(questions).toEqual([]);
    expect(started).toBeDefined();
    for (const nodeId of sessionNodes) {
      expect(owners[nodeId]).toBe(started?.claudeSessionId);
      expect(nodeStatus(events.filter((event) => event.nodeId === nodeId))).toBe("done");
    }
  });
});
