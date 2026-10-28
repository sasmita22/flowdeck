import { join } from "node:path";

export function resolveFlowdeckHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env["FLOWDECK_HOME"] ?? join(homeDir, ".flowdeck");
}
