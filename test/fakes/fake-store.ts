import type { ActivityEntry } from "../../src/core/run/activity.js";
import type {
  BuildEvent,
  PendingBuild,
  StoredBuildEvent,
} from "../../src/core/run/build-progress.js";
import { stateMovingKinds, type RunEvent } from "../../src/core/run/run-events.js";
import {
  mergeOtherRepos,
  type OtherRepo,
  type RepoState,
  type RunRepoStates,
} from "../../src/core/run/repo-state.js";
import {
  BuildRunningError,
  type RepoStatePhase,
  type RunBuildCopy,
  type StepText,
  type StepTextField,
} from "../../src/core/run/store.js";
import type {
  BuildFileRecord,
  BuildRecord,
  BuildSnapshot,
  BuildWorktree,
  EventEntry,
  NewBuild,
  NewPendingBuild,
  NewRun,
  PendingBuildEnd,
  PendingBuildStart,
  RunRecord,
  RunSessionRecord,
  RunStatus,
  RunStory,
  RunSummary,
  SnapshotKey,
  Store,
  StoredEvent,
} from "../../src/ports/store.js";

type RecordedBuild = Omit<NewBuild, "manifest"> & { manifest?: string };

const copy = <T>(value: T): T => structuredClone(value);

const stateMoving = new Set(stateMovingKinds);

const storyLineOf = (story: RunStory | undefined): { storyLine?: string } => {
  const storyLine = story?.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return storyLine === undefined ? {} : { storyLine };
};

const keep = <T>(list: T[], kept: (item: T) => boolean) => {
  const remaining = list.filter(kept);
  list.splice(0, list.length, ...remaining);
};

export class FakeStore implements Store {
  private readonly runRecords: RunRecord[] = [];
  private readonly sessionsByRun = new Map<string, RunSessionRecord[]>();
  private readonly nodeSessionsByRun = new Map<string, Record<string, string>>();
  private readonly nodeEntries: { runId: string; nodeId: string }[] = [];
  private readonly stored: { runId: string; event: StoredEvent }[] = [];
  private readonly buildRecords: RecordedBuild[] = [];
  private readonly manifests = new Map<string, string>();
  private readonly worktrees = new Map<string, BuildWorktree[]>();
  private readonly buildCreatedAt = new Map<string, number>();
  private readonly runNumbers = new Map<string, number>();
  private readonly lastRunNumbers = new Map<string, number>();
  private readonly costs = new Map<string, number>();
  private readonly activityByRun = new Map<string, Map<number, ActivityEntry>>();
  private readonly stories: RunStory[] = [];
  private readonly repoStateRows: {
    runId: string;
    phase: RepoStatePhase;
    state: RepoState;
    otherRepos: OtherRepo[];
    repo?: string;
  }[] = [];
  private readonly stepTextRows: {
    runId: string;
    entryId: number;
    field: StepTextField;
    text: string;
  }[] = [];
  private readonly now: () => Date;
  private readonly pendingBuilds: PendingBuild[] = [];
  private readonly buildEventLog: { pendingId: string; event: StoredBuildEvent }[] = [];
  private readonly buildActivityLog: { pendingId: string; entry: ActivityEntry }[] = [];
  private readonly buildStepTextRows: {
    pendingId: string;
    entryId: number;
    field: StepTextField;
    text: string;
  }[] = [];
  private readonly snapshots: BuildSnapshot[] = [];
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

  createRun({ sessions = [], ...run }: NewRun): RunRecord {
    this.refuseWhileRunning(run.buildId);
    const record: RunRecord = {
      ...copy(run),
      ...this.buildCopyOf(run.buildId),
      id: `run-${this.nextRun++}`,
      status: "running",
    };
    this.runRecords.push(record);
    const parent = run.session.claudeSessionId;
    this.sessionsByRun.set(record.id, [
      { ...run.session, parent: null },
      ...sessions.map(({ tmuxName, cwd, claudeSessionId }) => ({
        tmuxName,
        cwd,
        claudeSessionId,
        parent,
      })),
    ]);
    const owners = new Map(
      sessions.flatMap((session) =>
        (session.nodeIds ?? []).map((nodeId) => [nodeId, session.claudeSessionId] as const),
      ),
    );
    this.nodeSessionsByRun.set(
      record.id,
      Object.fromEntries(run.nodeIds.map((nodeId) => [nodeId, owners.get(nodeId) ?? parent])),
    );
    const number = (this.lastRunNumbers.get(run.buildId) ?? 0) + 1;
    this.lastRunNumbers.set(run.buildId, number);
    this.runNumbers.set(record.id, number);
    for (const nodeId of run.nodeIds) this.nodeEntries.push({ runId: record.id, nodeId });
    return copy(record);
  }

  findRun(id: string): RunRecord | undefined {
    const record = this.runRecords.find((run) => run.id === id);
    return record && copy(record);
  }

  runSessions(runId: string): RunSessionRecord[] {
    return copy(this.sessionsByRun.get(runId) ?? []);
  }

  nodeSessions(runId: string): Record<string, string> {
    return { ...this.nodeSessionsByRun.get(runId) };
  }

  listRuns(): RunSummary[] {
    return this.runRecords
      .map((run, index) => this.summaryOf(run, index))
      .reverse()
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
  }

  findRunSummary(id: string): RunSummary | undefined {
    const index = this.runRecords.findIndex((run) => run.id === id);
    const run = this.runRecords[index];
    return run && this.summaryOf(run, index);
  }

  deleteRun(runId: string): void {
    const ofOtherRuns = <T extends { runId: string }>(list: T[]) => {
      keep(list, (item) => item.runId !== runId);
    };
    keep(this.runRecords, (run) => run.id !== runId);
    ofOtherRuns(this.nodeEntries);
    ofOtherRuns(this.stored);
    ofOtherRuns(this.stories);
    ofOtherRuns(this.repoStateRows);
    ofOtherRuns(this.stepTextRows);
    this.activityByRun.delete(runId);
    this.sessionsByRun.delete(runId);
    this.costs.delete(runId);
    this.runNumbers.delete(runId);
  }

  private buildCopyOf(buildId: string): RunBuildCopy {
    const built = this.buildRecords.find((known) => known.id === buildId);
    return {
      buildName: built?.name ?? null,
      buildHash: built?.hash ?? null,
      blueprintName: this.snapshotOf(buildId)?.blueprintName ?? null,
      ...(built?.source === undefined ? {} : { source: copy(built.source) }),
      repo: built?.repo ?? null,
      branch: built?.branch ?? null,
      buildValues: built === undefined ? null : copy(built.values),
      manifestJson: this.manifests.get(buildId) ?? null,
    };
  }

  private summaryOf(run: RunRecord, index: number): RunSummary {
    const events = this.events(run.id);
    const last = events.at(-1);
    const owners = this.nodeSessionsByRun.get(run.id) ?? {};
    const startedOwners = new Set(
      events.filter((event) => stateMoving.has(event.kind)).map((event) => owners[event.nodeId]),
    );
    const counted = run.nodeIds.filter((nodeId) => {
      const owner = owners[nodeId];
      return owner === run.session.claudeSessionId || startedOwners.has(owner);
    });
    const doneCount = counted.filter(
      (nodeId) =>
        events.findLast((event) => event.nodeId === nodeId && stateMoving.has(event.kind))?.kind ===
        "done",
    ).length;
    return {
      id: run.id,
      status: run.status,
      ...(run.buildId === undefined ? {} : { buildId: run.buildId }),
      createdAt: new Date(index).toISOString(),
      endedAt: run.status === "running" ? null : (last?.time ?? null),
      totalCost: this.costs.get(run.id) ?? null,
      nodeCount: counted.length,
      ...(run.source === undefined ? {} : { source: copy(run.source) }),
      buildName: run.buildName,
      blueprintName: run.blueprintName,
      blueprintVersion: run.source?.version ?? null,
      buildGone: !this.buildRecords.some((known) => known.id === run.buildId),
      number: this.runNumbers.get(run.id) ?? 0,
      doneCount,
      ...storyLineOf(this.latestRunStory(run.id)),
    };
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

  builds(): RecordedBuild[] {
    return copy(this.buildRecords);
  }

  recordBuild(build: NewBuild): void {
    this.recordBuildWithoutManifest(build);
    this.manifests.set(build.id, build.manifest);
  }

  recordBuildWithoutManifest(build: RecordedBuild): void {
    if (this.buildRecords.some((known) => known.id === build.id)) {
      throw new Error(`FakeStore: builds are locked (${build.id} is recorded)`);
    }
    if (this.findBuildByName(build.name) !== undefined) {
      throw new Error(`FakeStore: UNIQUE name ${build.name}`);
    }
    this.buildRecords.push(copy(build));
    this.buildCreatedAt.set(build.id, this.buildCreatedAt.size + 1);
  }

  findBuild(id: string): BuildRecord | undefined {
    return this.allBuilds().find((build) => build.id === id);
  }

  findBuildByName(name: string): BuildRecord | undefined {
    return this.listBuilds().find((build) => build.name === name);
  }

  deleteBuild(id: string): void {
    this.removePendingBuilds(
      this.pendingBuilds.filter((known) => known.buildId === id).map((known) => known.id),
    );
    keep(this.snapshots, (known) => known.buildId !== id);
    keep(this.buildRecords, (known) => known.id !== id);
    this.manifests.delete(id);
    this.lastRunNumbers.delete(id);
    this.worktrees.delete(id);
  }

  private removePendingBuilds(ids: readonly string[]): void {
    const removed = new Set(ids);
    for (const gone of this.pendingBuilds.filter((known) => ids.includes(known.id))) {
      const goneAt = this.pendingBuilds.indexOf(gone);
      this.pendingBuilds.forEach((older, olderAt) => {
        if (
          older.name === gone.name &&
          older !== gone &&
          older.buildId === undefined &&
          older.endedAt !== undefined &&
          (older.startedAt < gone.startedAt ||
            (older.startedAt === gone.startedAt && olderAt < goneAt))
        ) {
          removed.add(older.id);
        }
      });
    }
    for (const pendingId of removed) {
      const session = this.buildEventLog.findLast(
        (known) => known.pendingId === pendingId && known.event.type === "session",
      )?.event;
      if (session?.type === "session") this.worktrees.delete(session.buildId);
    }
    keep(this.buildActivityLog, (known) => !removed.has(known.pendingId));
    keep(this.buildEventLog, (known) => !removed.has(known.pendingId));
    keep(this.buildStepTextRows, (known) => !removed.has(known.pendingId));
    keep(
      this.snapshots,
      (known) =>
        known.pendingId === null || !removed.has(known.pendingId) || known.buildId !== null,
    );
    keep(this.pendingBuilds, (known) => !removed.has(known.id));
  }

  listBuilds(): BuildRecord[] {
    return this.allBuilds();
  }

  addBuildWorktree(buildId: string, worktree: BuildWorktree): void {
    this.worktrees.set(buildId, [...(this.worktrees.get(buildId) ?? []), copy(worktree)]);
  }

  buildWorktrees(buildId: string): BuildWorktree[] {
    return copy(this.worktrees.get(buildId) ?? []);
  }

  startPendingBuild(build: NewPendingBuild): PendingBuildStart {
    const open = this.openPendingBuilds();
    if (open.some((known) => known.name === build.name)) return { kind: "busy", reason: "name" };
    const pendingId = `pending-${this.nextPending++}`;
    const { snapshot, ...pendingBuild } = build;
    this.pendingBuilds.push({ ...copy(pendingBuild), id: pendingId });
    if (snapshot !== undefined) {
      this.snapshots.push({ ...copy(snapshot), pendingId, buildId: null });
    }
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
    const unlinked = this.snapshots.find(
      (known) => known.pendingId === pendingId && known.buildId === null,
    );
    if (end.buildId !== undefined && unlinked !== undefined) {
      if (this.snapshotOf(end.buildId) !== undefined) {
        throw new Error(`FakeStore: UNIQUE snapshot build id ${end.buildId}`);
      }
      unlinked.buildId = end.buildId;
    }
    Object.assign(record, copy(end));
  }

  listPendingBuilds(): PendingBuild[] {
    return this.openPendingBuilds();
  }

  private openPendingBuilds(): PendingBuild[] {
    return this.pendingBuilds.filter((known) => known.endedAt === undefined).map(copy);
  }

  listLatestEndedPendingBuildsByName(): PendingBuild[] {
    const latest = new Map<string, PendingBuild>();
    for (const known of this.pendingBuilds) {
      if (known.endedAt === undefined) continue;
      const kept = latest.get(known.name);
      if (kept?.endedAt === undefined || known.endedAt >= kept.endedAt) {
        latest.set(known.name, known);
      }
    }
    return [...latest.values()]
      .filter((known) => known.outcome !== "built")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .map(copy);
  }

  findPendingBuildByName(name: string): PendingBuild | undefined {
    return this.openPendingBuilds().find((known) => known.name === name);
  }

  pendingBuild(id: string): PendingBuild | null {
    const known = this.pendingBuilds.find((record) => record.id === id);
    return known === undefined ? null : copy(known);
  }

  deletePendingBuild(id: string): void {
    this.removePendingBuilds([id]);
  }

  appendBuildActivity(pendingId: string, entry: ActivityEntry): void {
    this.buildActivityLog.push({ pendingId, entry: copy(entry) });
  }

  buildActivity(pendingId: string): ActivityEntry[] {
    return this.buildActivityLog
      .filter((known) => known.pendingId === pendingId)
      .map(({ entry }) => copy(entry));
  }

  buildSnapshot(key: SnapshotKey): BuildSnapshot | null {
    const known =
      "pendingId" in key
        ? this.snapshots.find((snapshot) => snapshot.pendingId === key.pendingId)
        : this.snapshotOf(key.buildId);
    return known === undefined ? null : copy(known);
  }

  buildManifest(buildId: string): string | undefined {
    return this.manifests.get(buildId);
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

  appendRunStory(story: RunStory): void {
    this.stories.push(copy(story));
  }

  latestRunStory(runId: string): RunStory | undefined {
    const story = this.stories.findLast((told) => told.runId === runId);
    return story && copy(story);
  }

  appendRepoState(
    runId: string,
    phase: RepoStatePhase,
    state: RepoState,
    otherRepos: OtherRepo[],
  ): void {
    this.repoStateRows.push(copy({ runId, phase, state, otherRepos }));
  }

  appendOtherRepoBefore(runId: string, repo: string, state: RepoState): void {
    this.repoStateRows.push(copy({ runId, phase: "before", state, otherRepos: [], repo }));
  }

  repoStates(runId: string): RunRepoStates {
    const ofRun = this.repoStateRows.filter((row) => row.runId === runId);
    const before = ofRun.find((row) => row.phase === "before" && row.repo === undefined);
    const after = ofRun.findLast((row) => row.phase === "after" && row.repo === undefined);
    const befores = new Map<string, RepoState>();
    for (const row of ofRun) {
      if (row.repo !== undefined && !befores.has(row.repo)) befores.set(row.repo, row.state);
    }
    const otherRepos = mergeOtherRepos(befores, after?.otherRepos ?? []);
    return copy({ before: before?.state ?? null, after: after?.state ?? null, otherRepos });
  }

  appendStepText(runId: string, entryId: number, field: StepTextField, text: string): void {
    this.stepTextRows.push({ runId, entryId, field, text });
  }

  stepTexts(runId: string, entryId: number): StepText[] {
    const latest = new Map<StepTextField, string>();
    for (const row of this.stepTextRows) {
      if (row.runId === runId && row.entryId === entryId) latest.set(row.field, row.text);
    }
    return [...latest]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([field, text]) => ({ field, text }));
  }

  appendBuildStepText(
    pendingId: string,
    entryId: number,
    field: StepTextField,
    text: string,
  ): void {
    this.buildStepTextRows.push({ pendingId, entryId, field, text });
  }

  buildStepTexts(pendingId: string, entryId: number): StepText[] {
    const ofEntry = this.buildStepTextRows.filter(
      (row) => row.pendingId === pendingId && row.entryId === entryId,
    );
    return ofEntry
      .filter((row, at) => !ofEntry.slice(at + 1).some((later) => later.field === row.field))
      .map(({ field, text }) => ({ field, text }));
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
      .map(
        ({
          id,
          hash,
          name,
          repo,
          base,
          branch,
          branchCreated,
          values,
          dir,
          source,
        }): BuildRecord => {
          const snapshot = this.snapshotOf(id);
          return {
            id,
            hash,
            name,
            repo,
            base,
            branch,
            branchCreated,
            values: copy(values),
            deletedAt: null,
            dir,
            createdAt: this.buildCreatedAt.get(id) ?? 0,
            ...(source === undefined ? {} : { source: copy(source) }),
            blueprintName: snapshot?.blueprintName ?? null,
            blueprintVersion: snapshot?.version ?? null,
          };
        },
      )
      .reverse();
  }

  private snapshotOf(buildId: string): BuildSnapshot | undefined {
    return this.snapshots.find((snapshot) => snapshot.buildId === buildId);
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
