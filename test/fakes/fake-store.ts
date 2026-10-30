import type { RunEvent } from "../../src/core/run/run-events.js";
import type {
  EventEntry,
  NewBuild,
  NewRun,
  RunRecord,
  RunStatus,
  Store,
  StoredEvent,
} from "../../src/ports/store.js";

const copy = <T>(value: T): T => structuredClone(value);

export class FakeStore implements Store {
  private readonly runRecords: RunRecord[] = [];
  private readonly nodeEntries: { runId: string; nodeId: string }[] = [];
  private readonly stored: { runId: string; event: StoredEvent }[] = [];
  private readonly buildRecords: NewBuild[] = [];
  private nextRun = 1;
  private nextSeq = 1;

  get runs(): readonly RunRecord[] {
    return copy(this.runRecords);
  }

  get nodes(): readonly { runId: string; nodeId: string }[] {
    return copy(this.nodeEntries);
  }

  createRun(run: NewRun): RunRecord {
    const record: RunRecord = { ...copy(run), id: `run-${this.nextRun++}`, status: "running" };
    this.runRecords.push(record);
    for (const nodeId of run.nodeIds) this.nodeEntries.push({ runId: record.id, nodeId });
    return copy(record);
  }

  findRun(id: string): RunRecord | undefined {
    const record = this.runRecords.find((run) => run.id === id);
    return record && copy(record);
  }

  append(runId: string, nodeId: string, event: RunEvent): void {
    this.appendAll(runId, [{ nodeId, event }]);
  }

  appendAll(runId: string, entries: readonly EventEntry[]): void {
    for (const { nodeId } of entries) {
      if (!this.nodeEntries.some((node) => node.runId === runId && node.nodeId === nodeId)) {
        throw new Error(`FakeStore: no node ${nodeId} in run ${runId}`);
      }
    }
    for (const { nodeId, event } of entries) {
      this.stored.push({
        runId,
        event: { ...copy(event), nodeId, seq: this.nextSeq++, time: new Date(0).toISOString() },
      });
    }
  }

  events(runId: string): StoredEvent[] {
    return this.stored.filter((entry) => entry.runId === runId).map(({ event }) => copy(event));
  }

  builds(): NewBuild[] {
    return copy(this.buildRecords);
  }

  recordBuild(build: NewBuild): void {
    if (this.buildRecords.some((known) => known.hash === build.hash)) return;
    this.buildRecords.push(copy(build));
  }

  finishRun(runId: string, status: Exclude<RunStatus, "running">): void {
    const record = this.runRecords.find((run) => run.id === runId);
    if (!record) throw new Error(`FakeStore: no run ${runId}`);
    record.status = status;
  }
}
