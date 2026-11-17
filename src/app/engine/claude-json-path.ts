import { join } from "node:path";

export function userClaudeJsonPath(
  env: { FLOWDECK_CLAUDE_CONFIG?: string; CLAUDE_CONFIG_DIR?: string },
  home: string,
): string {
  return env.FLOWDECK_CLAUDE_CONFIG || join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
}
