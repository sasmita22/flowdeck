import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli, claudeCommand, replyLine } from "../../../src/adapters/claude/claude-cli.js";
import { FakeSessionHost } from "../../fakes/fake-session-host.js";

const sessionId = "0b7c2f4e-1d2a-4c3b-9e8f-5a6b7c8d9e0f";
const rule = "─".repeat(40);
const readyPane = ["╭─ Claude Code ─╮", rule, "❯ ", rule, "  ? for shortcuts"].join("\n");
const dialog = (cursorOnYes: boolean) =>
  [
    " Accessing workspace:",
    " /private/var/folders/x/fd-repo-abc",
    " Quick safety check: Is this a project you created or one you trust?",
    rule,
    cursorOnYes ? "  No, exit" : "❯ No, exit",
    cursorOnYes ? "❯ Yes, I trust this folder" : "  Yes, I trust this folder",
    rule,
    " Enter to confirm · Esc to cancel",
  ].join("\n");
const dialogPane = dialog(false);
const dialogOnYes = dialog(true);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("claudeCommand", () => {
  it("strips the parent session's variables and starts claude with the session id and model", () => {
    expect(claudeCommand({ sessionId, model: "haiku" })).toBe(
      "env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION" +
        " -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_MESSAGING_SOCKET" +
        " -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID" +
        ` -u CLAUDE_EFFORT claude --session-id ${sessionId} --model haiku`,
    );
  });

  it("keeps the user's telemetry setting", () => {
    expect(claudeCommand({ sessionId, model: "haiku" })).not.toContain(
      "CLAUDE_CODE_ENABLE_TELEMETRY",
    );
  });
});

describe("replyLine", () => {
  it("does not match the echoed prompt", () => {
    expect(replyLine("FD-PONG").test("❯ Reply with exactly: FD-PONG")).toBe(false);
  });

  it("matches claude's reply line", () => {
    expect(replyLine("FD-PONG").test("❯ Reply with exactly: FD-PONG\n\n⏺ FD-PONG\n")).toBe(true);
  });

  it("does not match a reply with another token", () => {
    expect(replyLine("FD-PONG").test("⏺ FD-PING")).toBe(false);
  });
});

describe("ClaudeCli", () => {
  let sessions: FakeSessionHost;
  let cli: ClaudeCli;
  let home: string;

  beforeEach(async () => {
    sessions = new FakeSessionHost();
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    cli = new ClaudeCli({
      sessions,
      homeDir: home,
      pollIntervalMs: 2,
      readyTimeoutMs: 100,
      dialogSettleMs: 10,
    });
    await sessions.start("fd-a", "/work", "claude");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("starts claude in the session with the built command", async () => {
    await cli.start("fd-b", "/repo", { sessionId, model: "haiku" });

    expect(sessions.get("fd-b")).toEqual({
      cwd: "/repo",
      command: claudeCommand({ sessionId, model: "haiku" }),
    });
  });

  it("is ready without sending anything when the input box is showing", async () => {
    sessions.setPane("fd-a", readyPane);

    await cli.waitUntilReady("fd-a");

    expect(sessions.inputs("fd-a")).toEqual([]);
  });

  it("answers the trust dialog with Down, then a separate Enter", async () => {
    sessions.setPane("fd-a", dialogPane);
    sessions.onInput("fd-a", (input) => {
      if ("key" in input && input.key === "Down") sessions.setPane("fd-a", dialogOnYes);
      if ("key" in input && input.key === "Enter") sessions.setPane("fd-a", readyPane);
    });

    await cli.waitUntilReady("fd-a");

    expect(sessions.inputs("fd-a")).toEqual([{ key: "Down" }, { key: "Enter" }]);
  });

  it("does not take the trust dialog for readiness, and answers it once", async () => {
    sessions.setPane("fd-a", dialogPane);
    sessions.onInput("fd-a", (input) => {
      if ("key" in input && input.key === "Down") sessions.setPane("fd-a", dialogOnYes);
    });

    await expect(cli.waitUntilReady("fd-a")).rejects.toThrow(
      'Claude in session "fd-a" was not ready within 100 ms',
    );
    expect(sessions.inputs("fd-a")).toEqual([{ key: "Down" }, { key: "Enter" }]);
  });

  it("does not take a trust dialog drawn like the input box for readiness", async () => {
    const boxed = (option: string) =>
      [
        " Quick safety check: Is this a project you created or one you trust?",
        rule,
        option,
        rule,
      ].join("\n");
    sessions.setPane("fd-a", boxed("❯ No, exit"));
    sessions.onInput("fd-a", (input) => {
      if ("key" in input && input.key === "Down") {
        sessions.setPane("fd-a", boxed("❯ Yes, I trust this folder"));
      }
    });

    await expect(cli.waitUntilReady("fd-a")).rejects.toThrow(
      'Claude in session "fd-a" was not ready within 100 ms',
    );
    expect(sessions.inputs("fd-a")).toEqual([{ key: "Down" }, { key: "Enter" }]);
  });

  it("does not answer the trust dialog before it has settled", async () => {
    const settling = new ClaudeCli({
      sessions,
      homeDir: home,
      pollIntervalMs: 2,
      readyTimeoutMs: 100,
      dialogSettleMs: 1000,
    });
    sessions.setPane("fd-a", dialogPane);

    await expect(settling.waitUntilReady("fd-a")).rejects.toThrow(
      'Claude in session "fd-a" was not ready within 100 ms',
    );
    expect(sessions.inputs("fd-a")).toEqual([]);
  });

  it("presses Enter only once the cursor is on Yes", async () => {
    let paneAtEnter = "";
    sessions.setPane("fd-a", dialogPane);
    sessions.onInput("fd-a", (input) => {
      if ("key" in input && input.key === "Down") {
        void sleep(30).then(() => sessions.setPane("fd-a", dialogOnYes));
      }
      if ("key" in input && input.key === "Enter") {
        void sessions.capture("fd-a").then((pane) => (paneAtEnter = pane));
        sessions.setPane("fd-a", readyPane);
      }
    });

    await cli.waitUntilReady("fd-a");

    expect(paneAtEnter).toBe(dialogOnYes);
    expect(sessions.inputs("fd-a")).toEqual([{ key: "Down" }, { key: "Enter" }]);
  });

  it("never presses Enter when the cursor does not reach Yes", async () => {
    sessions.setPane("fd-a", dialogPane);

    await expect(cli.waitUntilReady("fd-a")).rejects.toThrow(
      'Claude in session "fd-a" did not move the trust dialog cursor to "Yes, I trust this folder" within 100 ms',
    );
    expect(sessions.inputs("fd-a")).toEqual([{ key: "Down" }]);
  });

  it("gives up on a pane that never becomes ready, sending nothing", async () => {
    const started = Date.now();

    await expect(cli.waitUntilReady("fd-a")).rejects.toThrow(
      'Claude in session "fd-a" was not ready within 100 ms',
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sessions.inputs("fd-a")).toEqual([]);
  });

  it("refuses a prompt before claude is ready", async () => {
    await expect(cli.sendPrompt("fd-a", "hello")).rejects.toThrow(
      'Claude in session "fd-a" is not ready for a prompt',
    );
    expect(sessions.inputs("fd-a")).toEqual([]);
  });

  it("types the prompt once claude is ready", async () => {
    sessions.setPane("fd-a", readyPane);
    await cli.waitUntilReady("fd-a");

    await cli.sendPrompt("fd-a", "hello");

    expect(sessions.inputs("fd-a")).toEqual([{ text: "hello" }]);
  });

  it("forgets readiness when the session is started again", async () => {
    await cli.start("fd-b", "/repo", { sessionId, model: "haiku" });
    sessions.setPane("fd-b", readyPane);
    await cli.waitUntilReady("fd-b");
    await sessions.stop("fd-b");
    await cli.start("fd-b", "/repo", { sessionId, model: "haiku" });

    await expect(cli.sendPrompt("fd-b", "hello")).rejects.toThrow(
      'Claude in session "fd-b" is not ready for a prompt',
    );
  });

  it("resolves with the pane once the reply appears", async () => {
    sessions.setPane("fd-a", readyPane);
    sessions.onInput("fd-a", (input) => {
      if ("text" in input) sessions.setPane("fd-a", `❯ ${input.text}\n\n⏺ FD-PONG\n${readyPane}`);
    });
    await cli.waitUntilReady("fd-a");
    await cli.sendPrompt("fd-a", "Reply with exactly: FD-PONG");

    const pane = await cli.waitForReply("fd-a", replyLine("FD-PONG"), 100);

    expect(pane).toContain("⏺ FD-PONG");
  });

  it("gives up when the reply never appears", async () => {
    sessions.setPane("fd-a", `❯ Reply with exactly: FD-PONG\n${readyPane}`);

    await expect(cli.waitForReply("fd-a", replyLine("FD-PONG"), 50)).rejects.toThrow(
      'No reply in session "fd-a" within 50 ms',
    );
  });

  it("finds the transcript named after the session id", async () => {
    const folder = join(home, ".claude", "projects", "-private-var-fd-repo-abc");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${sessionId}.jsonl`), "");

    expect(await cli.findTranscript(sessionId)).toBe(join(folder, `${sessionId}.jsonl`));
    expect(await cli.findTranscript("11111111-2222-3333-4444-555555555555")).toBeUndefined();
  });

  it("finds no transcript when claude has no projects folder", async () => {
    expect(await cli.findTranscript(sessionId)).toBeUndefined();
  });

  it("skips a stray file in the projects folder", async () => {
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, "stray"), "");

    expect(await cli.findTranscript(sessionId)).toBeUndefined();
  });

  it("reports a project folder it cannot read instead of treating it as empty", async () => {
    const folder = join(home, ".claude", "projects", "-locked");
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o000);
    try {
      await expect(cli.findTranscript(sessionId)).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(folder, 0o700);
    }
  });
});
