export type UsageEntry = {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  text?: string;
};

export type UsageReader = { entries(sessionId: string): Promise<UsageEntry[]> };

type Rates = { input: number; output: number; cacheRead: number };

const fable: Rates = { input: 10, output: 50, cacheRead: 0.25 };
const opus: Rates = { input: 5, output: 25, cacheRead: 0.5 };
const sonnet: Rates = { input: 2, output: 10, cacheRead: 0.2 };

export const prices: Record<string, Rates> = {
  "claude-fable-5-1": fable,
  "claude-mythos-5-1": fable,
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": opus,
  "claude-opus-4-8": opus,
  "claude-opus-4-7": opus,
  "claude-opus-4-6": opus,
  "claude-sonnet-5-5": sonnet,
  "claude-sonnet-5": sonnet,
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

const longPrompt = { model: "claude-haiku-5-5", above: 100_000 };
const longPromptRates: Rates = { input: 0.5, output: 2.5, cacheRead: 0.05 };

const mostExpensive = Object.values(prices).reduce((top, rates) =>
  rates.output > top.output ? rates : top,
);

function knownPrefix(model: string): string | undefined {
  return Object.keys(prices)
    .filter((prefix) => model.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
}

function ratesFor(entry: UsageEntry): Rates {
  const prefix = knownPrefix(entry.model);
  if (prefix === undefined) return mostExpensive;
  const prompt =
    entry.inputTokens + entry.cacheWrite5mTokens + entry.cacheWrite1hTokens + entry.cacheReadTokens;
  if (prefix === longPrompt.model && prompt > longPrompt.above) return longPromptRates;
  return prices[prefix] ?? mostExpensive;
}

function priceOf(entry: UsageEntry): number {
  const rates = ratesFor(entry);
  return (
    (entry.inputTokens * rates.input +
      entry.outputTokens * rates.output +
      entry.cacheWrite5mTokens * rates.input * 1.25 +
      entry.cacheWrite1hTokens * rates.input * 2 +
      entry.cacheReadTokens * rates.cacheRead) /
    1_000_000
  );
}

export function costOf(entries: UsageEntry[]): number {
  const byMessage = new Map(entries.map((entry) => [entry.messageId, entry]));
  return [...byMessage.values()].reduce((sum, entry) => sum + priceOf(entry), 0);
}

export const budgetReached = (spend: number, budget: number) => spend >= budget;

export function usd(amount: number): string {
  return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}
