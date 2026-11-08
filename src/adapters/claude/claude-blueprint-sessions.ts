import { randomUUID } from "node:crypto";
import type { BlueprintSessionSpec, BlueprintSessions } from "../../ports/blueprint-sessions.js";
import type { SessionHost } from "../../ports/session-host.js";
import type { ClaudeCli } from "./claude-cli.js";

export type ClaudeBlueprintSessionsDeps = {
  sessions: (socketName: string) => SessionHost;
  cli: (sessions: SessionHost) => ClaudeCli;
};

export class ClaudeBlueprintSessions implements BlueprintSessions {
  constructor(private readonly deps: ClaudeBlueprintSessionsDeps) {}

  async start({
    session,
    cwd,
    settingsPath,
    mcpConfigPath,
    kitDir,
    socketPath,
  }: BlueprintSessionSpec): Promise<void> {
    const cli = this.deps.cli(this.deps.sessions(session));
    await cli.start(
      session,
      cwd,
      { sessionId: randomUUID() },
      {
        settingsPath,
        pluginDirs: [kitDir],
        mcpConfigPath,
        env: {
          FLOWDECK_SOCK: socketPath,
          FLOWDECK_BP_SOCK: socketPath,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        },
      },
    );
    await cli.waitUntilReady(session);
  }

  async stop(session: string): Promise<void> {
    const sessions = this.deps.sessions(session);
    if (await sessions.has(session)) await sessions.stop(session);
  }

  async alive(session: string): Promise<boolean> {
    return this.deps.sessions(session).has(session);
  }
}
