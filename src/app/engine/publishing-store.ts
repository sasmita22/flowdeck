import { runSnapshot } from "../../core/run/snapshot.js";
import type { RunStatus, Store } from "../../ports/store.js";
import type { EnginePush } from "./protocol.js";

export type PublishingStoreOptions = {
  store: Store;
  runId: string;
  nodeIds: readonly string[];
  publish: (push: EnginePush) => void;
};

export function createPublishingStore(options: PublishingStoreOptions): Store {
  const { store, runId, nodeIds, publish } = options;

  let status: RunStatus = "running";

  const publishFor = (id: string): void => {
    if (id !== runId) return;
    publish({
      push: "run-state",
      value: runSnapshot({ runId, status, nodeIds, events: store.events(runId) }),
    });
  };

  return {
    createRun: (run) => store.createRun(run),
    findRun: (id) => store.findRun(id),
    events: (id) => store.events(id),
    recordCost: (id, totalCost) => store.recordCost(id, totalCost),
    recordBuild: (build) => store.recordBuild(build),
    findBuild: (id) => store.findBuild(id),
    findBuildByName: (name) => store.findBuildByName(name),
    deleteBuild: (id) => store.deleteBuild(id),
    listBuilds: () => store.listBuilds(),
    listBuildsWithDeleted: () => store.listBuildsWithDeleted(),
    listRuns: () => store.listRuns(),
    buildFiles: (id) => store.buildFiles(id),
    startPendingBuild: (build) => store.startPendingBuild(build),
    appendBuildEvent: (pendingId, event) => store.appendBuildEvent(pendingId, event),
    buildEvents: (pendingId) => store.buildEvents(pendingId),
    endPendingBuild: (pendingId, end) => store.endPendingBuild(pendingId, end),
    listPendingBuilds: () => store.listPendingBuilds(),
    listLatestEndedPendingBuilds: () => store.listLatestEndedPendingBuilds(),
    findPendingBuildByName: (name) => store.findPendingBuildByName(name),
    pendingBuild: (id) => store.pendingBuild(id),
    appendBuildActivity: (pendingId, entry) => store.appendBuildActivity(pendingId, entry),
    buildActivity: (pendingId) => store.buildActivity(pendingId),
    buildSnapshot: (key) => store.buildSnapshot(key),
    listSnapshotGaps: () => store.listSnapshotGaps(),
    addSnapshotIfMissing: (gap, snapshot) => store.addSnapshotIfMissing(gap, snapshot),
    recordActivity: (id, entry) => store.recordActivity(id, entry),
    activity: (id) => store.activity(id),
    append(id, nodeId, event) {
      store.append(id, nodeId, event);
      publishFor(id);
    },
    appendAll(id, entries) {
      store.appendAll(id, entries);
      publishFor(id);
    },
    reopenRun(id) {
      store.reopenRun(id);
      if (id === runId) status = "running";
      publishFor(id);
    },
    stopRun(id) {
      store.stopRun(id);
      if (id === runId) status = store.findRun(id)?.status ?? status;
      publishFor(id);
    },
    finishRun(id, final) {
      store.finishRun(id, final);
      if (id === runId) status = final;
      publishFor(id);
    },
  };
}
