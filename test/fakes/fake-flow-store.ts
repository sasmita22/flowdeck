import type { Flow } from "../../src/core/flow/schema.js";
import type {
  FlowStore,
  FlowSummary,
  LoadedFlow,
  NewBlueprint,
  SavedFlowRef,
} from "../../src/ports/flow-store.js";

const copy = <T>(value: T): T => structuredClone(value);

const cleanName = (name: string): string => {
  if (name.trim() === "") throw new Error("A blueprint needs a name");
  return name.trim();
};

type Blueprint = {
  flowId: string;
  name: string;
  createdAt: string;
  touched: number;
  pinned: boolean;
};

export class FakeFlowStore implements FlowStore {
  private readonly newId: () => string;
  private readonly blueprints: Blueprint[] = [];
  private readonly versions: LoadedFlow[] = [];
  private nextFailure: Error | undefined;
  private nextFlow = 1;
  private clock = 0;

  constructor(options: { newId?: () => string } = {}) {
    this.newId = options.newId ?? (() => `flow-${this.nextFlow++}`);
  }

  failNextSave(error: Error): void {
    this.nextFailure = error;
  }

  create(name: string): FlowSummary {
    const blueprint = this.add(name);
    return this.summary(blueprint);
  }

  list(): FlowSummary[] {
    return [...this.blueprints]
      .sort((a, b) => b.touched - a.touched)
      .map((blueprint) => this.summary(blueprint));
  }

  rename(flowId: string, name: string): void {
    if (name.trim() === "") throw new Error("A blueprint needs a name");
    this.find(flowId).name = name.trim();
  }

  pin(flowId: string, pinned: boolean): void {
    this.find(flowId).pinned = pinned;
  }

  save(flow: Flow, target?: string | NewBlueprint): SavedFlowRef {
    const failure = this.nextFailure;
    if (failure !== undefined) {
      this.nextFailure = undefined;
      throw failure;
    }
    const blueprint = this.blueprintFor(target);
    const version = this.versions.filter((saved) => saved.flowId === blueprint.flowId).length + 1;
    this.versions.push({
      flowId: blueprint.flowId,
      name: blueprint.name,
      version,
      flow: copy(flow),
    });
    blueprint.touched = ++this.clock;
    return { flowId: blueprint.flowId, version };
  }

  load(ref: SavedFlowRef): LoadedFlow | null {
    const found = this.versions.find(
      (saved) => saved.flowId === ref.flowId && saved.version === ref.version,
    );
    return found ? { ...copy(found), name: this.find(found.flowId).name } : null;
  }

  loadLatest(flowId: string | undefined = this.versions.at(-1)?.flowId): LoadedFlow | null {
    const latest = this.versions.filter((saved) => saved.flowId === flowId).at(-1);
    return latest ? this.load(latest) : null;
  }

  private add(name: string): Blueprint {
    const blueprint = {
      flowId: this.newId(),
      name,
      createdAt: new Date(0).toISOString(),
      touched: ++this.clock,
      pinned: false,
    };
    this.blueprints.push(blueprint);
    return blueprint;
  }

  private blueprintFor(target: string | NewBlueprint | undefined): Blueprint {
    if (typeof target === "string") return this.find(target);
    if (target !== undefined) return this.add(cleanName(target.name));
    return this.blueprintOf(this.versions.at(-1)?.flowId) ?? this.add("Untitled");
  }

  private blueprintOf(flowId: string | undefined): Blueprint | undefined {
    return this.blueprints.find((blueprint) => blueprint.flowId === flowId);
  }

  private find(flowId: string): Blueprint {
    const found = this.blueprintOf(flowId);
    if (found === undefined) throw new Error(`No blueprint ${flowId}`);
    return found;
  }

  private summary(blueprint: Blueprint): FlowSummary {
    const saved = this.versions.filter((version) => version.flowId === blueprint.flowId);
    const latest = saved.at(-1);
    return {
      flowId: blueprint.flowId,
      name: blueprint.name,
      createdAt: blueprint.createdAt,
      versions: saved.length,
      lastSavedAt: latest === undefined ? null : blueprint.createdAt,
      buildConfig: latest?.flow.session.buildConfig ?? null,
      pinned: blueprint.pinned,
    };
  }
}
