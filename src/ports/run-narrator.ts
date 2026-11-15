export type RunNarration = { text: string; cost: number };

export interface RunNarrator {
  narrate(digest: string, signal: AbortSignal): Promise<RunNarration>;
}
