import type { Flow } from "../../src/core/flow/schema.js";
import type { FlowStore, LoadedFlow, SavedFlowRef } from "../../src/ports/flow-store.js";

const copy = <T>(value: T): T => structuredClone(value);

export class FakeFlowStore implements FlowStore {
  private readonly newId: () => string;
  private readonly versions: LoadedFlow[] = [];
  private nextFailure: Error | undefined;
  private nextFlow = 1;

  constructor(options: { newId?: () => string } = {}) {
    this.newId = options.newId ?? (() => `flow-${this.nextFlow++}`);
  }

  failNextSave(error: Error): void {
    this.nextFailure = error;
  }

  save(flow: Flow): SavedFlowRef {
    const failure = this.nextFailure;
    if (failure !== undefined) {
      this.nextFailure = undefined;
      throw failure;
    }
    const latest = this.versions.at(-1);
    const saved: LoadedFlow = latest
      ? { ...latest, version: latest.version + 1, flow: copy(flow) }
      : { flowId: this.newId(), name: "Untitled", version: 1, flow: copy(flow) };
    this.versions.push(saved);
    return { flowId: saved.flowId, version: saved.version };
  }

  loadLatest(): LoadedFlow | null {
    const latest = this.versions.at(-1);
    return latest ? copy(latest) : null;
  }
}
