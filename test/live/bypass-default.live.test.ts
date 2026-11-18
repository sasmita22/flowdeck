import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARENT_SESSION_VARS } from "../../src/adapters/claude/claude-cli.js";
import { newCanvasFlow } from "../../src/app/renderer/canvas/store.js";
import type { Flow } from "../../src/core/flow/schema.js";
import type { HumanWaiter, WaitRequest } from "../../src/core/run/wait.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";
import { claudeConfigDir, useTempClaudeConfig } from "../fixtures/claude-config.js";

const run = promisify(execFile);
const consentKey = "skipDangerousModePermissionPrompt";
const runDeadlineMs = 240_000;
const fileName = "bypass.txt";

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then" as const,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function newBlueprint(): Flow {
  const flow = newCanvasFlow();
  return {
    ...flow,
    nodes: [
      { id: "t", label: "Start", type: "trigger", position: at(0), settings: {} },
      {
        id: "p1",
        label: "Write",
        type: "agent",
        position: at(1),
        settings: {
          role: "",
          instructions: `Create the file ${fileName} containing ok.`,
          model: "haiku",
        },
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
    session: { ...flow.session, model: "haiku" },
  };
}

function withoutKey<T>(record: Record<string, T>, ...keys: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

const childEnv = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
  withoutKey({ ...process.env, ...overrides }, ...PARENT_SESSION_VARS);

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a new blueprint never asks", () => {
  const sessionName = `fd-live-byp-${process.pid}`;
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

  async function runsToDoneWithoutAsking(): Promise<void> {
    const questions: WaitRequest[] = [];
    const waiter: HumanWaiter = {
      wait: async (request) => {
        questions.push(request);
        return { decision: "reject", reason: "no question expected" };
      },
    };
    engine = liveEngine({ home, repo: repo.path, sessionName, waiter });
    const built = await engine.saveAndBuild(newBlueprint(), { name: "live-bypass" });
    const settings = JSON.parse(await readFile(join(built.dir, "settings.json"), "utf8")) as {
      permissions: { defaultMode: string };
    };
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");

    const runId = await engine.runBuild(built.buildId);
    const status = await engine.waitForRunEnd(runId, runDeadlineMs);
    const events = engine.stores.runs.events(runId);
    const written = await readFile(join(built.workFolder, fileName), "utf8").catch(() => undefined);
    console.log(
      [
        `status: ${status}`,
        `questions: ${JSON.stringify(questions)}`,
        `events:\n${events.map((e) => `${e.nodeId} ${e.kind} ${JSON.stringify("payload" in e ? e.payload : "")}`).join("\n")}`,
        `${fileName}: ${JSON.stringify(written)}`,
      ].join("\n"),
    );

    expect(status).toBe("done");
    expect(events).toContainEqual(expect.objectContaining({ nodeId: "p1", kind: "done" }));
    expect(events.filter((e) => e.kind === "needs-you")).toEqual([]);
    expect(questions).toEqual([]);
    expect(written).toBeDefined();
  }

  describe("on the normal config", () => {
    useTempClaudeConfig();

    it("runs to done", { timeout: 360_000 }, async () => {
      await runsToDoneWithoutAsking();
    });
  });

  describe("on a logged-in config that never accepted the bypass warning", () => {
    useTempClaudeConfig({ settings: (settings) => withoutKey(settings, consentKey) });

    it("runs to done", { timeout: 420_000 }, async () => {
      const configDir = claudeConfigDir();

      const grep = await run("grep", ["-rl", consentKey, configDir]).catch(
        (error: { code?: number; stdout?: string }) => ({ code: error.code, stdout: error.stdout }),
      );
      expect(grep).toMatchObject({ code: 1, stdout: "" });

      const login = await run("claude", ["-p", "--model", "haiku", "Say ok"], {
        cwd: dirname(configDir),
        env: childEnv({}),
      }).catch((error: { stdout?: string; stderr?: string }) => ({
        stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
        stderr: "failed",
      }));
      expect(login.stdout).not.toMatch(/not logged in/i);
      expect(login.stderr).not.toBe("failed");

      await runsToDoneWithoutAsking();
    });
  });
});
