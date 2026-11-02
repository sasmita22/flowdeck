import type { UsageEntry } from "./budget.js";

export const contextWindows: Record<string, number> = {
  "claude-fable-5-1": 1_000_000,
  "claude-mythos-5-1": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

export const compactShare = 0.8;

export type CompactionReader = { compactions(sessionId: string): Promise<number> };

const smallestWindow = Math.min(...Object.values(contextWindows));

export function contextWindowOf(model: string): number {
  const prefix = Object.keys(contextWindows)
    .filter((known) => model.startsWith(known))
    .sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? smallestWindow : (contextWindows[prefix] ?? smallestWindow);
}

export type ContextUse = { messageId: string; tokens: number; window: number };

export function contextUse(entries: readonly UsageEntry[]): ContextUse | undefined {
  const last = entries.findLast((entry) => entry.agentType === undefined);
  if (last === undefined) return undefined;
  return {
    messageId: last.messageId,
    tokens:
      last.inputTokens + last.cacheWrite5mTokens + last.cacheWrite1hTokens + last.cacheReadTokens,
    window: contextWindowOf(last.model),
  };
}

export const contextFull = (use: ContextUse): boolean => use.tokens >= use.window * compactShare;
