import type { UsageEntry, UsageSource } from "../../src/ports/usage-source.js";

export class FakeUsageSource implements UsageSource {
  readonly calls: string[] = [];
  private readonly bySession = new Map<string, UsageEntry[]>();
  private readonly queued = new Map<string, UsageEntry[][]>();
  private readonly compactionsBySession = new Map<string, number>();

  setEntries(sessionId: string, entries: UsageEntry[]): void {
    this.bySession.set(sessionId, entries);
  }

  queueReads(sessionId: string, ...reads: UsageEntry[][]): void {
    this.queued.set(sessionId, [...(this.queued.get(sessionId) ?? []), ...reads]);
  }

  async entries(sessionId: string): Promise<UsageEntry[]> {
    this.calls.push(sessionId);
    return this.queued.get(sessionId)?.shift() ?? this.bySession.get(sessionId) ?? [];
  }

  compacted(sessionId: string): void {
    this.compactionsBySession.set(sessionId, (this.compactionsBySession.get(sessionId) ?? 0) + 1);
  }

  async compactions(sessionId: string): Promise<number> {
    return this.compactionsBySession.get(sessionId) ?? 0;
  }
}
