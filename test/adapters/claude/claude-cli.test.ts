import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli, claudeCommand } from "../../../src/adapters/claude/claude-cli.js";
import { FakeSessionHost } from "../../fakes/fake-session-host.js";

const sessionId = "0b7c2f4e-1d2a-4c3b-9e8f-5a6b7c8d9e0f";
const settingsPath = "/tmp/fd home/sessions/s1/settings.json";
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
  it("strips the parent session's variables and starts claude with the session id, model and settings", () => {
    expect(claudeCommand({ sessionId, model: "haiku" }, settingsPath)).toBe(
      "env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION" +
        " -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_MESSAGING_SOCKET" +
        " -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID" +
        ` -u CLAUDE_EFFORT claude --session-id ${sessionId} --model 'haiku'` +
        " --settings '/tmp/fd home/sessions/s1/settings.json'",
    );
  });

  it("quotes the model as one shell word", () => {
    expect(claudeCommand({ sessionId, model: "claude haiku; touch x" })).toContain(
      " --model 'claude haiku; touch x'",
    );
  });

  it("adds no settings without a settings path", () => {
    expect(claudeCommand({ sessionId, model: "haiku" })).not.toContain("--settings");
  });

  it("loads the plugin folder, quoted like the settings path", () => {
    expect(
      claudeCommand({ sessionId, model: "haiku" }, settingsPath, "/tmp/fd home/builds/abc"),
    ).toMatch(
      / --settings '\/tmp\/fd home\/sessions\/s1\/settings\.json' --plugin-dir '\/tmp\/fd home\/builds\/abc'$/,
    );
  });

  it("loads no plugin folder without one", () => {
    expect(claudeCommand({ sessionId, model: "haiku" }, settingsPath)).not.toContain(
      "--plugin-dir",
    );
  });

  it("keeps the user's telemetry setting", () => {
    expect(claudeCommand({ sessionId, model: "haiku" })).not.toContain(
      "CLAUDE_CODE_ENABLE_TELEMETRY",
    );
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

  it("starts claude with the settings file and the session environment", async () => {
    await cli.start(
      "fd-b",
      "/repo",
      { sessionId, model: "haiku" },
      { settingsPath, env: { FLOWDECK_SOCK: "/s" } },
    );

    expect(sessions.get("fd-b")?.env).toEqual({ FLOWDECK_SOCK: "/s" });
    expect(sessions.get("fd-b")?.command).toContain(
      "--settings '/tmp/fd home/sessions/s1/settings.json'",
    );
  });

  it("starts claude with the build folder as its plugin folder", async () => {
    await cli.start(
      "fd-b",
      "/repo",
      { sessionId, model: "haiku" },
      { settingsPath, pluginDir: "/fd/builds/abc" },
    );

    expect(sessions.get("fd-b")?.command).toBe(
      claudeCommand({ sessionId, model: "haiku" }, settingsPath, "/fd/builds/abc"),
    );
    expect(sessions.get("fd-b")?.command).toContain("--plugin-dir '/fd/builds/abc'");
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

  describe("sending a prompt", () => {
    const boxPane = (...box: string[]) =>
      ["╭─ Claude Code ─╮", rule, ...box, rule, "  ? for shortcuts"].join("\n");
    const placeholderPane = boxPane('❯ Try "fix lint errors"');

    async function readyCli(options: { submitRetryMs: number; readyTimeoutMs?: number }) {
      const ready = new ClaudeCli({
        sessions,
        homeDir: home,
        pollIntervalMs: 2,
        readyTimeoutMs: options.readyTimeoutMs ?? 1000,
        submitRetryMs: options.submitRetryMs,
      });
      sessions.setPane("fd-a", readyPane);
      await ready.waitUntilReady("fd-a");
      return ready;
    }

    function claudeBox(options: {
      box?: string[];
      showAfterMs?: number;
      emptyAfterEnters: number;
    }) {
      let enters = 0;
      sessions.onInput("fd-a", (input) => {
        if ("typed" in input) {
          const show = () =>
            sessions.setPane("fd-a", boxPane(...(options.box ?? [`❯ ${input.typed}`])));
          if (options.showAfterMs === undefined) show();
          else setTimeout(show, options.showAfterMs);
        }
        if ("key" in input && input.key === "Enter" && ++enters === options.emptyAfterEnters) {
          sessions.setPane("fd-a", readyPane);
        }
      });
    }

    it("types the prompt without Enter, then presses Enter once it shows in the box", async () => {
      const ready = await readyCli({ submitRetryMs: 1000 });
      claudeBox({ emptyAfterEnters: 1 });

      await ready.sendPrompt("fd-a", "hello");

      expect(sessions.inputs("fd-a")).toEqual([{ typed: "hello" }, { key: "Enter" }]);
    });

    it.each([
      ["an empty box", readyPane],
      ["the placeholder", placeholderPane],
    ])("waits out %s shown before the typed prompt renders", async (_, before) => {
      const ready = await readyCli({ submitRetryMs: 1000 });
      sessions.setPane("fd-a", before);
      claudeBox({ showAfterMs: 30, emptyAfterEnters: 1 });

      await ready.sendPrompt("fd-a", "hello");

      expect(sessions.inputs("fd-a")).toEqual([{ typed: "hello" }, { key: "Enter" }]);
    });

    it("presses Enter again while the box still holds the prompt", async () => {
      const ready = await readyCli({ submitRetryMs: 10 });
      claudeBox({ emptyAfterEnters: 3 });

      await ready.sendPrompt("fd-a", "hello");

      expect(sessions.inputs("fd-a")).toEqual([
        { typed: "hello" },
        { key: "Enter" },
        { key: "Enter" },
        { key: "Enter" },
      ]);
    });

    it("sees a prompt wrapped over several box lines as held", async () => {
      const ready = await readyCli({ submitRetryMs: 1000 });
      claudeBox({
        box: ["❯ Use the Write tool to create a.txt", "  containing exactly: 123"],
        emptyAfterEnters: 1,
      });

      await ready.sendPrompt("fd-a", "Use the Write tool to create a.txt containing exactly: 123");

      expect(sessions.inputs("fd-a")).toEqual([
        { typed: "Use the Write tool to create a.txt containing exactly: 123" },
        { key: "Enter" },
      ]);
    });

    it("never presses Enter when the prompt never shows in the box", async () => {
      const ready = await readyCli({ submitRetryMs: 10, readyTimeoutMs: 100 });
      sessions.setPane("fd-a", placeholderPane);

      await expect(ready.sendPrompt("fd-a", "hello")).rejects.toThrow(
        'Claude in session "fd-a" did not show the prompt in its input box within 100 ms',
      );
      expect(sessions.inputs("fd-a")).toEqual([{ typed: "hello" }]);
    });

    it("does not take the same prompt echoed above an empty box as typed", async () => {
      const ready = await readyCli({ submitRetryMs: 10, readyTimeoutMs: 100 });
      sessions.setPane("fd-a", ["❯ hello", "", "⏺ Hi there", rule, "❯ ", rule].join("\n"));

      await expect(ready.sendPrompt("fd-a", "hello")).rejects.toThrow(
        'Claude in session "fd-a" did not show the prompt in its input box within 100 ms',
      );
      expect(sessions.inputs("fd-a")).toEqual([{ typed: "hello" }]);
    });

    it("gives up naming the session when the box never empties", async () => {
      const ready = await readyCli({ submitRetryMs: 10, readyTimeoutMs: 100 });
      claudeBox({ emptyAfterEnters: Infinity });

      await expect(ready.sendPrompt("fd-a", "hello")).rejects.toThrow(
        'Claude in session "fd-a" did not submit the prompt within 100 ms',
      );
    });

    it("returns once the box empties with the submitted prompt echoed above it", async () => {
      const ready = await readyCli({ submitRetryMs: 1000 });
      sessions.onInput("fd-a", (input) => {
        if ("typed" in input) sessions.setPane("fd-a", boxPane("❯ hello"));
        if ("key" in input) {
          sessions.setPane("fd-a", ["❯ hello", "", "⏺ Hi there", rule, "❯ ", rule].join("\n"));
        }
      });

      await ready.sendPrompt("fd-a", "hello");

      expect(sessions.inputs("fd-a")).toEqual([{ typed: "hello" }, { key: "Enter" }]);
    });

    it.each(["", "  \n "])("refuses the empty prompt %j without typing it", async (prompt) => {
      const ready = await readyCli({ submitRetryMs: 10, readyTimeoutMs: 100 });

      await expect(ready.sendPrompt("fd-a", prompt)).rejects.toThrow(
        'Claude in session "fd-a" was given an empty prompt',
      );
      expect(sessions.inputs("fd-a")).toEqual([]);
    });
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
