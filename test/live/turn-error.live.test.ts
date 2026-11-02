import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { build } from "../../src/core/compiler/build.js";
import { nodeStatus } from "../../src/core/run/run-events.js";
import * as builders from "../fixtures/flow-builders.js";
import { killTmuxServer, removeClaudeSessions } from "../fixtures/live-claude.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = join(root, "node_modules", ".bin", "tsx");
const runDeadlineMs = 60_000;
const notLoggedIn = "Not logged in · Please run /login";

type Exit = { code: number | null; stdout: string; stderr: string };

function runCliProcess(args: string[], env: NodeJS.ProcessEnv): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, ["src/cli/main.ts", ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const deadline = setTimeout(() => child.kill("SIGTERM"), runDeadlineMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, stdout, stderr });
    });
  });
}

function loggedOutEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FLOWDECK_HOME: home };
  delete env.USER;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a turn that errors, with real claude", () => {
  const sessionName = `fd-live-turn-error-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let sessionIds: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    sessionIds = [];
  });

  afterEach(async () => {
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
    await killTmuxServer(sessionName);
    await removeClaudeSessions(repo.path, sessionIds);
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "fails a logged-out session's Prompt node with its message, and the run ends failed",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const flow = builders.flow(
        [builders.trigger("t"), builders.prompt("p1", { settings: { instructions: "Say hi." } })],
        [builders.thenWire("t", "p1")],
      );
      const built = await build(flow, {
        fs: new NodeFileSystem(),
        home,
      });
      if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);

      const exit = await runCliProcess(
        ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
        loggedOutEnv(home),
      );

      const db = openDatabase({ path: join(home, "flowdeck.db") });
      try {
        const store = new SqliteStore({ db });
        const runIds = (db.prepare("SELECT id FROM runs").all() as { id: string }[]).map(
          (row) => row.id,
        );
        const runs = runIds.map((id) => store.findRun(id));
        sessionIds = runs.flatMap((record) => record?.session.claudeSessionId ?? []);
        const report = `exit ${exit.code}\nstdout:\n${exit.stdout}\nstderr:\n${exit.stderr}`;

        expect(exit.code, report).toBe(1);
        expect(
          exit.stdout.split("\n").filter((line) => line !== ""),
          report,
        ).toEqual(["p1 started", `p1 failed: ${notLoggedIn}`]);
        expect(runs.map((record) => record?.status)).toEqual(["failed"]);
        const p1Events = store.events(runIds[0] ?? "").filter((event) => event.nodeId === "p1");
        expect(nodeStatus(p1Events)).toBe("failed");
        expect(p1Events.at(-1)).toMatchObject({
          kind: "failed",
          payload: { message: `p1 failed: ${notLoggedIn}` },
        });
      } finally {
        db.close();
      }
    },
  );
});
