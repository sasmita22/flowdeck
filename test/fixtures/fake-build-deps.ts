import type { FileSystem } from "../../src/ports/file-system.js";
import { FakeBuildAgents } from "../fakes/fake-build-agents.js";

const kit = { dir: "/flowdeck-kit", version: "test-kit" };

export const fakeBuildDeps = (fs: FileSystem, home: string) => ({
  agents: new FakeBuildAgents({ fs }),
  kit,
  sessionName: () => "fd-build-TestKit1",
  newSessionId: () => "3f2a1c4e-0000-4000-8000-000000000001",
  settingsPath: `${home}/build-sessions/settings.json`,
  guardCommand: "flowdeck-build-guard",
  hookCommand: "flowdeck-hook",
});

export const fakeEngineBuildOptions = (fs: FileSystem) => ({
  buildAgents: new FakeBuildAgents({ fs }),
  kit: async () => kit,
});
