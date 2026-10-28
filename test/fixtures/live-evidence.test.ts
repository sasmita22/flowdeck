import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { paneText, transcriptTail, WatchdogError, withWatchdog } from "./live-evidence.js";

const run = promisify(execFile);

describe("withWatchdog", () => {
  it("returns the work's result when it settles in time, without the expiry step", async () => {
    let expired = false;

    const result = await withWatchdog(Promise.resolve(7), 1000, async () => {
      expired = true;
    });

    expect(result).toBe(7);
    expect(expired).toBe(false);
  });

  it("captures a real tmux pane on expiry, before it rejects and before cleanup", async () => {
    const socket = `fd-wd-${process.pid}`;
    const order: string[] = [];
    let pane = "";
    await run("tmux", [
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      socket,
      "printf 'Allow this command?\\n'; sleep 30",
    ]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const watched = withWatchdog(new Promise<never>(() => undefined), 50, async () => {
        pane = await paneText(socket, socket);
        order.push("capture");
      });

      await expect(watched).rejects.toBeInstanceOf(WatchdogError);
      order.push("rejected");
    } finally {
      await run("tmux", ["-L", socket, "kill-server"]).catch(() => undefined);
      const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
      await rm(join(socketFolder, socket), { force: true });
      order.push("cleanup");
    }

    expect(order).toEqual(["capture", "rejected", "cleanup"]);
    expect(pane).toContain("Allow this command?");
  });
});

describe("paneText", () => {
  it("returns the error instead of throwing when there is no server", async () => {
    expect(await paneText(`fd-wd-none-${process.pid}`, "x")).toMatch(/^no pane: /);
  });
});

describe("transcriptTail", () => {
  it("lists role and text, tool use and tool result of the last entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-transcript-"));
    try {
      const path = join(dir, "s.jsonl");
      const entries = [
        { type: "user", message: { role: "user", content: "/h:review" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Checking." },
              { type: "tool_use", name: "Bash", input: { command: "ls src" } },
            ],
          },
        },
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", content: "denied" }] },
        },
        { type: "summary" },
      ];
      await writeFile(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`);

      expect(await transcriptTail(path)).toEqual([
        "user: text: /h:review",
        "assistant: text: Checking.",
        'assistant: tool_use Bash {"command":"ls src"}',
        "user: tool_result: denied",
      ]);
      expect(await transcriptTail(path, 2)).toEqual([
        'assistant: tool_use Bash {"command":"ls src"}',
        "user: tool_result: denied",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names a missing transcript instead of throwing", async () => {
    expect(await transcriptTail("/nonexistent/s.jsonl")).toEqual([
      expect.stringMatching(/^no transcript: /),
    ]);
  });
});
