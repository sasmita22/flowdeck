import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { parseFlow, Session, type Flow } from "../../core/flow/schema.js";
import { upgradeFlow } from "../../core/flow/upgrade.js";
import { registry } from "../../core/nodes/registry.js";
import type {
  FlowStore,
  FlowSummary,
  LoadedFlow,
  NewBlueprint,
  SavedFlowRef,
} from "../../ports/flow-store.js";

export type SqliteFlowStoreOptions = {
  db: Database.Database;
  now?: () => Date;
  newId?: () => string;
};

type CurrentRow = {
  flow_id: string;
  name: string;
  version: number;
  session: string;
  notes: string;
};

type SummaryRow = {
  id: string;
  name: string;
  created_at: string;
  versions: number;
  last_saved_at: string | null;
  version: number | null;
  session: string | null;
  pinned: number;
};

type NodeRow = {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  parent: string | null;
  settings: string;
};

type WireRow = {
  kind: string;
  from_node: string;
  from_port: string;
  to_node: string;
  to_port: string;
  file: string | null;
};

const cleanName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("A blueprint needs a name");
  return trimmed;
};

export class SqliteFlowStore implements FlowStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: SqliteFlowStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  create(name: string): FlowSummary {
    const time = this.now().toISOString();
    const flowId = this.createFlow(time, cleanName(name));
    return this.summary(flowId);
  }

  list(): FlowSummary[] {
    const rows = this.db
      .prepare(
        `SELECT flows.id, flows.name, flows.created_at, flows.pinned,
                (SELECT count(*) FROM flow_versions WHERE flow_id = flows.id) AS versions,
                latest.saved_at AS last_saved_at, latest.version, latest.session
           FROM flows
           LEFT JOIN flow_versions AS latest ON latest.flow_id = flows.id
            AND latest.version = (SELECT MAX(version) FROM flow_versions WHERE flow_id = flows.id)
          ORDER BY COALESCE(latest.saved_at, flows.created_at) DESC, flows.rowid DESC`,
      )
      .all() as SummaryRow[];
    return rows.map((row) => this.toSummary(row));
  }

  rename(flowId: string, name: string): void {
    const changed = this.db
      .prepare("UPDATE flows SET name = ? WHERE id = ?")
      .run(cleanName(name), flowId).changes;
    if (changed === 0) throw new Error(`No blueprint ${flowId}`);
  }

  pin(flowId: string, pinned: boolean): void {
    const changed = this.db
      .prepare("UPDATE flows SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, flowId).changes;
    if (changed === 0) throw new Error(`No blueprint ${flowId}`);
  }

  save(flow: Flow, target?: string | NewBlueprint): SavedFlowRef {
    return this.db.transaction(() => {
      const time = this.now().toISOString();
      const flowId = this.flowIdFor(target, time);
      const { version } = this.db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM flow_versions WHERE flow_id = ?",
        )
        .get(flowId) as { version: number };

      const insertNode = this.db.prepare(
        `INSERT INTO nodes (flow_id, version, ordinal, id, type, label, x, y, parent, settings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertPort = this.db.prepare(
        `INSERT INTO ports (flow_id, version, node_id, ordinal, name, direction, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      flow.nodes.forEach((node, ordinal) => {
        insertNode.run(
          flowId,
          version,
          ordinal,
          node.id,
          node.type,
          node.label,
          node.position.x,
          node.position.y,
          node.parent ?? null,
          JSON.stringify(node.settings),
        );
        registry[node.type].ports.forEach((port, portOrdinal) => {
          insertPort.run(
            flowId,
            version,
            node.id,
            portOrdinal,
            port.name,
            port.direction,
            port.kind,
          );
        });
      });

      const insertWire = this.db.prepare(
        `INSERT INTO wires (flow_id, version, ordinal, kind, from_node, from_port, to_node, to_port, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      flow.wires.forEach((wire, ordinal) => {
        insertWire.run(
          flowId,
          version,
          ordinal,
          wire.kind,
          wire.from.node,
          wire.from.port,
          wire.to.node,
          wire.to.port,
          wire.kind === "file" ? wire.file : null,
        );
      });

      this.db
        .prepare(
          "INSERT INTO flow_versions (flow_id, version, session, notes, saved_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(flowId, version, JSON.stringify(flow.session), JSON.stringify(flow.notes ?? []), time);

      return { flowId, version };
    })();
  }

  loadLatest(flowId: string | undefined = this.currentFlowId()): LoadedFlow | null {
    if (flowId === undefined) return null;
    const { version } = this.db
      .prepare("SELECT MAX(version) AS version FROM flow_versions WHERE flow_id = ?")
      .get(flowId) as { version: number | null };
    return version === null ? null : this.load({ flowId, version });
  }

  load({ flowId, version }: SavedFlowRef): LoadedFlow | null {
    const current = this.db
      .prepare(
        `SELECT flow_versions.flow_id, flows.name, flow_versions.version, flow_versions.session,
                flow_versions.notes
           FROM flow_versions JOIN flows ON flows.id = flow_versions.flow_id
          WHERE flow_versions.flow_id = ? AND flow_versions.version = ?`,
      )
      .get(flowId, version) as CurrentRow | undefined;
    if (current === undefined) return null;

    const nodes = (
      this.db
        .prepare(
          `SELECT id, type, label, x, y, parent, settings FROM nodes
            WHERE flow_id = ? AND version = ? ORDER BY ordinal`,
        )
        .all(flowId, current.version) as NodeRow[]
    ).map((row) => ({
      id: row.id,
      type: row.type,
      label: row.label,
      position: { x: row.x, y: row.y },
      ...(row.parent === null ? {} : { parent: row.parent }),
      settings: JSON.parse(row.settings) as unknown,
    }));

    const wires = (
      this.db
        .prepare(
          `SELECT kind, from_node, from_port, to_node, to_port, file FROM wires
            WHERE flow_id = ? AND version = ? ORDER BY ordinal`,
        )
        .all(flowId, current.version) as WireRow[]
    ).map((row) => ({
      kind: row.kind,
      from: { node: row.from_node, port: row.from_port },
      to: { node: row.to_node, port: row.to_port },
      ...(row.file === null ? {} : { file: row.file }),
    }));

    const notes = JSON.parse(current.notes) as unknown[];

    return {
      flowId,
      name: current.name,
      version: current.version,
      flow: parseFlow({
        nodes,
        wires,
        session: JSON.parse(current.session) as unknown,
        ...(notes.length === 0 ? {} : { notes }),
      }),
    };
  }

  private toSummary(row: SummaryRow): FlowSummary {
    return {
      flowId: row.id,
      name: row.name,
      createdAt: row.created_at,
      versions: row.versions,
      lastSavedAt: row.last_saved_at,
      buildConfig:
        row.session === null || row.version === null
          ? null
          : this.upgradedSession(row.id, row.version, row.session).buildConfig,
      pinned: row.pinned === 1,
    };
  }

  private upgradedSession(flowId: string, version: number, session: string): Session {
    const triggers = (
      this.db
        .prepare(
          `SELECT type, settings FROM nodes
            WHERE flow_id = ? AND version = ? AND type = 'trigger' ORDER BY ordinal`,
        )
        .all(flowId, version) as { type: string; settings: string }[]
    ).map((row) => ({ type: row.type, settings: JSON.parse(row.settings) as unknown }));
    const upgraded = upgradeFlow({ nodes: triggers, session: JSON.parse(session) as unknown }) as {
      session: unknown;
    };
    return Session.parse(upgraded.session);
  }

  private currentFlowId(): string | undefined {
    const row = this.db
      .prepare("SELECT flow_id FROM flow_versions ORDER BY rowid DESC LIMIT 1")
      .get() as { flow_id: string } | undefined;
    return row?.flow_id;
  }

  private flowIdFor(target: string | NewBlueprint | undefined, time: string): string {
    if (typeof target === "string") {
      if (!this.exists(target)) throw new Error(`No blueprint ${target}`);
      return target;
    }
    if (target !== undefined) return this.createFlow(time, cleanName(target.name));
    return this.currentFlowId() ?? this.createFlow(time, "Untitled");
  }

  private exists(flowId: string): boolean {
    return this.db.prepare("SELECT 1 FROM flows WHERE id = ?").get(flowId) !== undefined;
  }

  private summary(flowId: string): FlowSummary {
    const found = this.list().find((flow) => flow.flowId === flowId);
    if (found === undefined) throw new Error(`No blueprint ${flowId}`);
    return found;
  }

  private createFlow(time: string, name: string): string {
    const id = this.newId();
    this.db
      .prepare("INSERT INTO flows (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, time);
    return id;
  }
}
