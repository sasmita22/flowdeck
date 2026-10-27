import { describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { openClaudeSession } from "../../src/cli/claude-session.js";
import { FakeSessionHost } from "../fakes/fake-session-host.js";

const rule = "─".repeat(40);
const readyPane = [rule, "❯ ", rule].join("\n");
const options = {
  sessionName: "fd-run",
  buildDir: "/fd/builds/abc",
  model: "haiku",
  socketPath: "/fd/sockets/fd-run.sock",
  cwd: "/repo",
};

class SlowStartHost extends FakeSessionHost {
  private release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  startCalls = 0;

  override async start(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    this.startCalls++;
    await this.gate;
    await super.start(name, cwd, command, env);
    this.setPane(name, readyPane);
  }

  finishStart(): void {
    this.release();
  }
}

function open(sessions: SlowStartHost) {
  const claude = new ClaudeCli({ sessions, pollIntervalMs: 2, readyTimeoutMs: 100 });
  return openClaudeSession(options, { sessions, claude, sessionId: "s1" });
}

describe("openClaudeSession", () => {
  it("starts Claude with the build as plugin folder and stops it", async () => {
    const sessions = new SlowStartHost();
    const opened = open(sessions);
    sessions.finishStart();

    await opened.session.ensureStarted();

    expect(sessions.get("fd-run")?.command).toContain("--plugin-dir '/fd/builds/abc'");
    expect(sessions.get("fd-run")?.env).toEqual({ FLOWDECK_SOCK: "/fd/sockets/fd-run.sock" });
    await opened.stop();
    expect(await sessions.list()).toEqual([]);
  });

  it("waits for a start in flight when stopped, then stops the session it made", async () => {
    const sessions = new SlowStartHost();
    const opened = open(sessions);
    const starting = opened.session.ensureStarted();
    const stopping = opened.stop();

    sessions.finishStart();
    await stopping;

    expect(await sessions.list()).toEqual([]);
    await expect(starting).rejects.toThrow("The run was stopped");
  });

  it("refuses to start once stopped", async () => {
    const sessions = new SlowStartHost();
    const opened = open(sessions);
    sessions.finishStart();
    await opened.stop();

    await expect(opened.session.ensureStarted()).rejects.toThrow("The run was stopped");
    expect(sessions.startCalls).toBe(0);
  });

  it("does nothing on stop when Claude was never started", async () => {
    const sessions = new SlowStartHost();

    await open(sessions).stop();

    expect(sessions.startCalls).toBe(0);
  });
});
