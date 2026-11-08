import { assert, describe, expect, it } from "vitest";
import { ClaudeBlueprintSessions } from "../../../src/adapters/claude/claude-blueprint-sessions.js";
import { ClaudeCli } from "../../../src/adapters/claude/claude-cli.js";
import type { BlueprintSessionSpec } from "../../../src/ports/blueprint-sessions.js";
import { FakeSessionHost } from "../../fakes/fake-session-host.js";

const rule = "─".repeat(40);
const readyPane = [rule, "❯ ", rule].join("\n");
const name = "fd-bp-alpha";
const spec: BlueprintSessionSpec = {
  session: name,
  cwd: "/fd/bp-sessions/alpha",
  settingsPath: "/fd/bp-sessions/alpha/settings.json",
  mcpConfigPath: "/fd/bp-sessions/alpha/mcp.json",
  kitDir: "/fd/kit/0123456789ab",
  socketPath: "/fd/sockets/bp.sock",
};

class ReadyHost extends FakeSessionHost {
  override async start(
    sessionName: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    await super.start(sessionName, cwd, command, env);
    this.setPane(sessionName, readyPane);
  }
}

function harness() {
  const hosts = new Map<string, ReadyHost>();
  const host = (socketName: string) => {
    let found = hosts.get(socketName);
    if (found === undefined) {
      found = new ReadyHost();
      hosts.set(socketName, found);
    }
    return found;
  };
  const sessions = new ClaudeBlueprintSessions({
    sessions: host,
    cli: (sessionHost) =>
      new ClaudeCli({ sessions: sessionHost, pollIntervalMs: 1, readyTimeoutMs: 200 }),
  });
  const started = () => {
    const session = hosts.get(name)?.get(name);
    if (session === undefined) assert.fail(`no tmux session ${name} on socket ${name}`);
    return session;
  };
  return { sessions, hosts, started };
}

describe("ClaudeBlueprintSessions", () => {
  describe("start", () => {
    it("starts a tmux session named after the spec, in the spec's folder", async () => {
      const t = harness();

      await t.sessions.start(spec);

      expect(await t.hosts.get(name)?.list()).toEqual([name]);
      expect(t.started().cwd).toBe(spec.cwd);
    });

    it("launches Claude with the session settings, the kit as its only plugin, and the MCP config", async () => {
      const t = harness();

      await t.sessions.start(spec);

      const command = t.started().command;
      expect(command).toContain(" claude --session-id ");
      expect(command).toContain(" --settings '/fd/bp-sessions/alpha/settings.json'");
      expect(command).toContain(" --plugin-dir '/fd/kit/0123456789ab'");
      expect(command.match(/--plugin-dir/g)).toHaveLength(1);
      expect(command).toContain(
        " --mcp-config '/fd/bp-sessions/alpha/mcp.json' --strict-mcp-config",
      );
    });

    it("gives Claude the hook socket and the blueprint socket, both the spec's socket, with background tasks off", async () => {
      const t = harness();

      await t.sessions.start(spec);

      expect(t.started().env).toMatchObject({
        FLOWDECK_SOCK: spec.socketPath,
        FLOWDECK_BP_SOCK: spec.socketPath,
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      });
    });
  });

  describe("stop", () => {
    it("ends the session", async () => {
      const t = harness();
      await t.sessions.start(spec);

      await t.sessions.stop(name);

      expect(await t.hosts.get(name)?.has(name)).toBe(false);
    });
  });

  describe("alive", () => {
    it("is true while the session host has the session and false once it ends", async () => {
      const t = harness();
      await t.sessions.start(spec);

      expect(await t.sessions.alive(name)).toBe(true);

      await t.hosts.get(name)?.stop(name);

      expect(await t.sessions.alive(name)).toBe(false);
    });

    it("is false for a session that was never started", async () => {
      const t = harness();

      expect(await t.sessions.alive("fd-bp-never")).toBe(false);
    });
  });
});
