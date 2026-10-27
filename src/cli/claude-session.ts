import { join } from "node:path";
import type { ClaudeCli } from "../adapters/claude/claude-cli.js";
import type { SessionHost } from "../ports/session-host.js";
import type { OpenedSession, OpenSessionOptions } from "./main.js";

const stopped = () => new Error("The run was stopped");

export function openClaudeSession(
  { sessionName, buildDir, model, socketPath, cwd }: OpenSessionOptions,
  { sessions, claude, sessionId }: { sessions: SessionHost; claude: ClaudeCli; sessionId: string },
): OpenedSession {
  let closed = false;
  let started = false;
  let starting: Promise<void> | undefined;
  return {
    sessionId,
    session: {
      ensureStarted: async () => {
        if (closed) throw stopped();
        starting = claude
          .start(
            sessionName,
            cwd,
            { sessionId, model },
            {
              settingsPath: join(buildDir, "settings.json"),
              pluginDir: buildDir,
              env: { FLOWDECK_SOCK: socketPath },
            },
          )
          .then(() => {
            started = true;
          });
        await starting;
        if (closed) throw stopped();
        await claude.waitUntilReady(sessionName);
      },
    },
    prompts: { sendPrompt: (text) => claude.sendPrompt(sessionName, text) },
    stop: async () => {
      closed = true;
      await starting?.catch(() => undefined);
      if (started && (await sessions.has(sessionName))) await sessions.stop(sessionName);
    },
  };
}
