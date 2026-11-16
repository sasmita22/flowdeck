import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { makeTempClaudeConfig, type Settings } from "../../scripts/claude-config.js";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";

const names = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] as const;

export function useTempClaudeConfig(options: { settings?: (settings: Settings) => Settings } = {}) {
  let root: string | undefined;
  let saved: Partial<Record<(typeof names)[number], string>> = {};

  beforeAll(async () => {
    saved = {};
    for (const name of names) {
      const value = process.env[name];
      if (value !== undefined) saved[name] = value;
    }
    root = await realpath(await mkdtemp(join(tmpdir(), "fd-cc-")));
    const { env } = await makeTempClaudeConfig({
      root,
      ...(options.settings && { settings: options.settings }),
    });
    Object.assign(process.env, env);
  });

  afterAll(async () => {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
}

export function claudeConfigDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir === undefined || dir === "") {
    throw new Error("no temp Claude config: call useTempClaudeConfig() in the describe");
  }
  return dir;
}

export const findClaudeTranscript = (sessionId: string) =>
  new ClaudeCli({ sessions: new TmuxSessionHost(), configDir: claudeConfigDir() }).findTranscript(
    sessionId,
  );
