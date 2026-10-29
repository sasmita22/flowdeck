import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { parseFlow, type Flow } from "../../core/flow/schema.js";
import { registry } from "../../core/nodes/registry.js";
import type { FlowStore, LoadedFlow, SavedFlowRef } from "../../ports/flow-store.js";

export type SqliteFlowStoreOptions = {
  db: Database.Database;
  now?: () => Date;
  newId?: () => string;
};

type CurrentRow = { flow_id: string; name: string; version: number; session: string };

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

export class SqliteFlowStore implements FlowStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: SqliteFlowStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  save(flow: Flow): SavedFlowRef {
    return this.db.transaction(() => {
      const time = this.now().toISOString();
      const flowId = this.currentFlowId() ?? this.createFlow(time);
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
          "INSERT INTO flow_versions (flow_id, version, session, saved_at) VALUES (?, ?, ?, ?)",
        )
        .run(flowId, version, JSON.stringify(flow.session), time);

      return { flowId, version };
    })();
  }

  loadLatest(): LoadedFlow | null {
    const flowId = this.currentFlowId();
    if (flowId === undefined) return null;
    const current = this.db
      .prepare(
        `SELECT flow_versions.flow_id, flows.name, flow_versions.version, flow_versions.session
           FROM flow_versions JOIN flows ON flows.id = flow_versions.flow_id
          WHERE flow_versions.flow_id = ?
          ORDER BY flow_versions.version DESC LIMIT 1`,
      )
      .get(flowId) as CurrentRow;

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

    return {
      flowId,
      name: current.name,
      version: current.version,
      flow: parseFlow({ nodes, wires, session: JSON.parse(current.session) as unknown }),
    };
  }

  private currentFlowId(): string | undefined {
    const row = this.db
      .prepare("SELECT flow_id FROM flow_versions ORDER BY rowid DESC LIMIT 1")
      .get() as { flow_id: string } | undefined;
    return row?.flow_id;
  }

  private createFlow(time: string): string {
    const id = this.newId();
    this.db
      .prepare("INSERT INTO flows (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, "Untitled", time);
    return id;
  }
}
