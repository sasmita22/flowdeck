import type { ActivityEntry } from "../../src/core/run/activity.js";
import type {
  BuildEvent,
  PendingBuild,
  StoredBuildEvent,
} from "../../src/core/run/build-progress.js";
import type { RunEvent } from "../../src/core/run/run-events.js";
import { BuildRunningError } from "../../src/core/run/store.js";
import type {
  BuildFileRecord,
  BuildRecord,
  EventEntry,
  NewBuild,
  NewPendingBuild,
  NewRun,
  PendingBuildEnd,
  PendingBuildStart,
  RunRecord,
  RunStatus,
  RunSummary,
  Store,
  StoredEvent,
} from "../../src/ports/store.js";

const copy = <T>(value: T): T => structuredClone(value);

export class FakeStore implements Store {
  private readonly runRecords: RunRecord[] = [];
  private readonly nodeEntries: { runId: string; nodeId: string }[] = [];
  private readonly stored: { runId: string; event: StoredEvent }[] = [];
  private readonly buildRecords: NewBuild[] = [];
  private readonly deletedAt = new Map<string, number>();
  private readonly costs = new Map<string, number>();
  private readonly activityByRun = new Map<string, Map<number, ActivityEntry>>();
  private readonly now: () => Date;
  private readonly pendingBuilds: PendingBuild[] = [];
  private readonly buildEventLog: { pendingId: string; event: StoredBuildEvent }[] = [];
  private readonly buildActivityLog: { pendingId: string; entry: ActivityEntry }[] = [];
  private nextRun = 1;
  private nextPending = 1;
  private nextSeq = 1;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date(0));
  }

  get runs(): readonly RunRecord[] {
    return copy(this.runRecords);
  }

  get nodes(): readonly { runId: string; nodeId: string }[] {
    return copy(this.nodeEntries);
  }

  createRun(run: NewRun): RunRecord {
    this.refuseWhileRunning(run.buildId);
    const record: RunRecord = { ...copy(run), id: `run-${this.nextRun++}`, status: "running" };
    this.runRecords.push(record);
    for (const nodeId of run.nodeIds) this.nodeEntries.push({ runId: record.id, nodeId });
    return copy(record);
  }

  findRun(id: string): RunRecord | undefined {
    const record = this.runRecords.find((run) => run.id === id);
    return record && copy(record);
  }

  listRuns(): RunSummary[] {
    const summaries = this.runRecords.flatMap((run, index): RunSummary[] => {
      if (run.buildId !== undefined && this.deletedAt.has(run.buildId)) return [];
      const source = this.buildRecords.find((known) => known.id === run.buildId)?.source;
      const last = this.events(run.id).at(-1);
      const summary: RunSummary = {
        id: run.id,
        status: run.status,
        ...(run.buildId === undefined ? {} : { buildId: run.buildId }),
        createdAt: new Date(index).toISOString(),
        endedAt: run.status === "running" ? null : (last?.time ?? null),
        totalCost: this.costs.get(run.id) ?? null,
        nodeCount: run.nodeIds.length,
        ...(source === undefined ? {} : { source: copy(source) }),
      };
      return [summary];
    });
    return summaries
      .reverse()
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
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
        event: { ...copy(event), nodeId, seq: this.nextSeq++, time: this.now().toISOString() },
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
    if (this.buildRecords.some((known) => known.id === build.id)) {
      throw new Error(`FakeStore: builds are locked (${build.id} is recorded)`);
    }
    if (this.findBuildByName(build.name) !== undefined) {
      throw new Error(`FakeStore: UNIQUE name ${build.name}`);
    }
    this.buildRecords.push(copy(build));
  }

  findBuild(id: string): BuildRecord | undefined {
    return this.allBuilds().find((build) => build.id === id);
  }

  findBuildByName(name: string): BuildRecord | undefined {
    return this.listBuilds().find((build) => build.name === name);
  }

  deleteBuild(id: string): void {
    if (this.deletedAt.has(id)) throw new Error(`FakeStore: builds are locked (${id} is deleted)`);
    if (this.buildRecords.some((build) => build.id === id)) {
      this.deletedAt.set(id, this.now().getTime());
    }
  }

  listBuilds(): BuildRecord[] {
    return this.allBuilds().filter((build) => build.deletedAt === null);
  }

  listBuildsWithDeleted(): BuildRecord[] {
    return this.allBuilds();
  }

  startPendingBuild(build: NewPendingBuild): PendingBuildStart {
    const open = this.listPendingBuilds();
    if (open.some((known) => known.flowId === build.flowId)) {
      return { kind: "busy", reason: "blueprint" };
    }
    if (open.some((known) => known.name === build.name)) return { kind: "busy", reason: "name" };
    const pendingId = `pending-${this.nextPending++}`;
    this.pendingBuilds.push({ ...copy(build), id: pendingId });
    return { kind: "started", pendingId };
  }

  appendBuildEvent(pendingId: string, event: BuildEvent): void {
    this.buildEventLog.push({
      pendingId,
      event: { ...copy(event), seq: this.nextSeq++, at: this.now().getTime() },
    });
  }

  buildEvents(pendingId: string): StoredBuildEvent[] {
    return this.buildEventLog
      .filter((entry) => entry.pendingId === pendingId)
      .map(({ event }) => copy(event));
  }

  endPendingBuild(pendingId: string, end: PendingBuildEnd): void {
    const record = this.pendingBuilds.find((known) => known.id === pendingId);
    if (!record) throw new Error(`FakeStore: no pending build ${pendingId}`);
    if (record.endedAt !== undefined) {
      throw new Error(`FakeStore: pending build ${pendingId} has ended`);
    }
    Object.assign(record, copy(end));
  }

  listPendingBuilds(): PendingBuild[] {
    return this.pendingBuilds.filter((known) => known.endedAt === undefined).map(copy);
  }

  listLatestEndedPendingBuilds(): PendingBuild[] {
    const latest = new Map<string, PendingBuild>();
    for (const known of this.pendingBuilds) {
      if (known.endedAt === undefined) continue;
      const kept = latest.get(known.flowId);
      if (kept?.endedAt === undefined || known.endedAt >= kept.endedAt) {
        latest.set(known.flowId, known);
      }
    }
    return [...latest.values()].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).map(copy);
  }

  findPendingBuildByName(name: string): PendingBuild | undefined {
    return this.listPendingBuilds().find((known) => known.name === name);
  }

  pendingBuild(id: string): PendingBuild | null {
    const known = this.pendingBuilds.find((record) => record.id === id);
    return known === undefined ? null : copy(known);
  }

  appendBuildActivity(pendingId: string, entry: ActivityEntry): void {
    this.buildActivityLog.push({ pendingId, entry: copy(entry) });
  }

  buildActivity(pendingId: string): ActivityEntry[] {
    return this.buildActivityLog
      .filter((known) => known.pendingId === pendingId)
      .map(({ entry }) => copy(entry));
  }

  buildFiles(id: string): BuildFileRecord[] {
    const files = this.buildRecords.find((build) => build.id === id)?.files ?? [];
    return copy(files).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  recordCost(runId: string, totalCost: number): void {
    this.costs.set(runId, totalCost);
  }

  costOf(runId: string): number | undefined {
    return this.costs.get(runId);
  }

  reopenRun(runId: string): void {
    const record = this.runRecords.find((run) => run.id === runId);
    if (!record) throw new Error(`FakeStore: no run ${runId}`);
    if (record.status !== "running") this.refuseWhileRunning(record.buildId);
    record.status = "running";
  }

  stopRun(runId: string): void {
    const record = this.runRecords.find((run) => run.id === runId);
    if (record?.status === "running") record.status = "stopped";
  }

  recordActivity(runId: string, entry: ActivityEntry): void {
    const entries = this.activityByRun.get(runId) ?? new Map<number, ActivityEntry>();
    entries.set(entry.id, copy(entry));
    this.activityByRun.set(runId, entries);
  }

  activity(runId: string): ActivityEntry[] {
    return [...(this.activityByRun.get(runId)?.values() ?? [])]
      .sort((a, b) => a.id - b.id)
      .map(copy);
  }

  finishRun(runId: string, status: Exclude<RunStatus, "running">): void {
    const record = this.runRecords.find((run) => run.id === runId);
    if (!record) throw new Error(`FakeStore: no run ${runId}`);
    record.status = status;
  }

  private allBuilds(): BuildRecord[] {
    return this.buildRecords
      .map(({ id, hash, name, repo, base, values, dir, source }, index): BuildRecord => ({
        id,
        hash,
        name,
        repo,
        base,
        values: copy(values),
        deletedAt: this.deletedAt.get(id) ?? null,
        dir,
        createdAt: index + 1,
        ...(source === undefined ? {} : { source: copy(source) }),
      }))
      .reverse();
  }

  private refuseWhileRunning(buildId: string | undefined): void {
    if (
      buildId !== undefined &&
      this.runRecords.some((run) => run.buildId === buildId && run.status === "running")
    ) {
      throw new BuildRunningError(buildId);
    }
  }
}
