import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFakeClaude } from "../../e2e/fake-claude.js";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { shellQuote } from "../../src/core/compiler/hook-settings.js";
import { killTmuxServer } from "../fixtures/live-claude.js";

describe("the fake Claude session", () => {
  const name = `fd-test-fake-session-${process.pid}`;
  let dir: string | undefined;
  let hooks: Server | undefined;

  afterEach(async () => {
    hooks?.close();
    hooks = undefined;
    await killTmuxServer(name);
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("shows the input box Claude's readiness check looks for", async () => {
    dir = await mkdtemp(join(tmpdir(), "fd-fake-session-"));
    const bin = join(dir, "bin");
    await writeFakeClaude(bin);
    const sessions = new TmuxSessionHost({ socketName: name });
    const command = [
      process.execPath,
      join(bin, "fake-claude.cjs"),
      "session",
      "--session-id",
      randomUUID(),
    ]
      .map(shellQuote)
      .join(" ");
    const sock = join(dir, "hooks.sock");
    hooks = createServer((socket) => socket.resume());
    await new Promise<void>((listening) => hooks?.listen(sock, listening));
    await sessions.start(name, dir, command, { FLOWDECK_SOCK: sock });

    const cli = new ClaudeCli({ sessions, readyTimeoutMs: 2000 });

    await expect(cli.waitUntilReady(name)).resolves.toBeUndefined();
  });
});
