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
    recordBuild: (build) => store.recordBuild(build),
    append(id, nodeId, event) {
      store.append(id, nodeId, event);
      publishFor(id);
    },
    appendAll(id, entries) {
      store.appendAll(id, entries);
      publishFor(id);
    },
    finishRun(id, final) {
      store.finishRun(id, final);
      if (id === runId) status = final;
      publishFor(id);
    },
  };
}
