import { describe, expect, it } from "vitest";
import { ClaudeCli } from "../../../src/adapters/claude/claude-cli.js";
import {
  openClaudeSession,
  SessionGoneError,
} from "../../../src/adapters/claude/claude-session.js";
import { FakeSessionHost } from "../../fakes/fake-session-host.js";

const rule = "─".repeat(40);
const readyPane = [rule, "❯ ", rule].join("\n");
const options = {
  sessionName: "fd-run",
  buildDir: "/fd/builds/abc",
  model: "haiku",
  socketPath: "/fd/sockets/fd-run.sock",
  cwd: "/repo",
  claudeSessionId: "s1",
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

class RecordingHost extends FakeSessionHost {
  readonly calls: string[] = [];

  override async start(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    this.calls.push("start");
    await super.start(name, cwd, command, env);
  }

  override async has(name: string): Promise<boolean> {
    this.calls.push("has");
    return super.has(name);
  }

  override async stop(name: string): Promise<void> {
    this.calls.push("stop");
    await super.stop(name);
  }

  override async capture(name: string): Promise<string> {
    this.calls.push("capture");
    return super.capture(name);
  }

  override async typeText(name: string, text: string): Promise<void> {
    this.calls.push("typeText");
    await super.typeText(name, text);
  }
}

function open(sessions: FakeSessionHost, attach = false) {
  const claude = new ClaudeCli({ sessions, pollIntervalMs: 2, readyTimeoutMs: 100 });
  return openClaudeSession({ ...options, attach }, { sessions, claude, sessionId: "s1" });
}

describe("openClaudeSession", () => {
  it("starts Claude with the build as plugin folder and stops it", async () => {
    const sessions = new SlowStartHost();
    const opened = await open(sessions);
    sessions.finishStart();

    await opened.session.ensureStarted();

    expect(sessions.get("fd-run")?.command).toContain("--plugin-dir '/fd/builds/abc'");
    expect(sessions.get("fd-run")?.env).toEqual({
      FLOWDECK_SOCK: "/fd/sockets/fd-run.sock",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
    await opened.stop();
    expect(await sessions.list()).toEqual([]);
  });

  it("waits for a start in flight when stopped, then stops the session it made", async () => {
    const sessions = new SlowStartHost();
    const opened = await open(sessions);
    const starting = opened.session.ensureStarted();
    const stopping = opened.stop();

    sessions.finishStart();
    await stopping;

    expect(await sessions.list()).toEqual([]);
    await expect(starting).rejects.toThrow("The run was stopped");
  });

  it("refuses to start once stopped", async () => {
    const sessions = new SlowStartHost();
    const opened = await open(sessions);
    sessions.finishStart();
    await opened.stop();

    await expect(opened.session.ensureStarted()).rejects.toThrow("The run was stopped");
    expect(sessions.startCalls).toBe(0);
  });

  it("does nothing on stop when Claude was never started", async () => {
    const sessions = new SlowStartHost();

    await (await open(sessions)).stop();

    expect(sessions.startCalls).toBe(0);
  });

  describe("attached to a session that is already running", () => {
    it("never starts Claude, waits until it is ready, and stops the session on stop", async () => {
      const sessions = new RecordingHost();
      await sessions.start("fd-run", "/repo", "claude");
      sessions.setPane("fd-run", readyPane);
      sessions.calls.length = 0;

      const opened = await open(sessions, true);
      await opened.session.ensureStarted();

      expect(sessions.calls).toEqual(["has", "capture"]);
      await opened.stop();
      expect(sessions.calls).not.toContain("start");
      expect(await sessions.list()).toEqual([]);
    });

    it("refuses a session that is gone and asks nothing else of tmux", async () => {
      const sessions = new RecordingHost();

      await expect(open(sessions, true)).rejects.toThrow(SessionGoneError);
      await expect(open(sessions, true)).rejects.toThrow('"fd-run"');
      expect(sessions.calls).toEqual(["has", "has"]);
    });
  });
});
