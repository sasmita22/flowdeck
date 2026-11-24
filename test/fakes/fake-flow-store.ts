import { blueprintFacts, noBlueprintFacts } from "../../src/core/flow/flow-store.js";
import type { LibraryResolver } from "../../src/core/flow/libraries.js";
import type { BuildConfig, Flow } from "../../src/core/flow/schema.js";
import { sessionBuildConfig } from "../../src/core/flow/structure.js";
import type {
  FlowStore,
  FlowSummary,
  LoadedFlow,
  NewBlueprint,
  SavedFlowRef,
} from "../../src/ports/flow-store.js";

const buildConfigOf = (flow: Flow): BuildConfig | null => sessionBuildConfig(flow) ?? null;

const copy = <T>(value: T): T => structuredClone(value);

const asSaved = ({ connections, ...flow }: Flow): Flow =>
  copy(connections === undefined || connections.length === 0 ? flow : { ...flow, connections });

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
  private readonly deleted = new Set<string>();
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
    return this.live()
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

  delete(flowId: string): void {
    this.deleted.add(this.find(flowId).flowId);
  }

  isDeleted(flowId: string): boolean {
    return this.deleted.has(flowId);
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
      flow: asSaved(flow),
    });
    blueprint.touched = ++this.clock;
    return { flowId: blueprint.flowId, version };
  }

  load(ref: SavedFlowRef): LoadedFlow | null {
    const found = this.versions.find(
      (saved) => saved.flowId === ref.flowId && saved.version === ref.version,
    );
    const owner = this.blueprints.find((blueprint) => blueprint.flowId === found?.flowId);
    return found && owner ? { ...copy(found), name: owner.name } : null;
  }

  loadLatest(flowId: string | undefined = this.latestLiveVersion()?.flowId): LoadedFlow | null {
    if (flowId !== undefined && this.deleted.has(flowId)) return null;
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
    return this.blueprintOf(this.latestLiveVersion()?.flowId) ?? this.add("Untitled");
  }

  private live(): Blueprint[] {
    return this.blueprints.filter((blueprint) => !this.deleted.has(blueprint.flowId));
  }

  private latestLiveVersion(): LoadedFlow | undefined {
    return this.versions.filter((saved) => !this.deleted.has(saved.flowId)).at(-1);
  }

  private blueprintOf(flowId: string | undefined): Blueprint | undefined {
    return this.live().find((blueprint) => blueprint.flowId === flowId);
  }

  private find(flowId: string): Blueprint {
    const found = this.blueprintOf(flowId);
    if (found === undefined) throw new Error(`No blueprint ${flowId}`);
    return found;
  }

  private readonly resolveLibrary: LibraryResolver = (flowId) => {
    const library = this.loadLatest(flowId);
    return library === null ? undefined : { name: library.name, flow: library.flow };
  };

  private summary(blueprint: Blueprint): FlowSummary {
    const saved = this.versions.filter((version) => version.flowId === blueprint.flowId);
    const latest = saved.at(-1);
    return {
      flowId: blueprint.flowId,
      name: blueprint.name,
      createdAt: blueprint.createdAt,
      versions: saved.length,
      lastSavedAt: latest === undefined ? null : blueprint.createdAt,
      buildConfig: latest === undefined ? null : buildConfigOf(latest.flow),
      ...(latest === undefined
        ? noBlueprintFacts
        : blueprintFacts(latest.flow, this.resolveLibrary)),
      pinned: blueprint.pinned,
    };
  }
}
