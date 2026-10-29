import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";

type RawNode = { id: string; parent?: string } & Record<string, unknown>;
type RawWire = { from: { node: string }; to: { node: string } } & Record<string, unknown>;
type RawFlow = { nodes: RawNode[]; wires: RawWire[]; session: unknown };

const allTypes = (): RawFlow =>
  JSON.parse(readFileSync(new URL("../../examples/all-types.json", import.meta.url), "utf8"));

function cloned(copies: number): Flow {
  const base = allTypes();
  const nodes: RawNode[] = [];
  const wires: RawWire[] = [];
  for (let k = 0; k < copies; k++) {
    for (const node of base.nodes) {
      nodes.push({
        ...node,
        id: `${node.id}-${k}`,
        ...(node.parent === undefined ? {} : { parent: `${node.parent}-${k}` }),
      });
    }
    for (const wire of base.wires) {
      wires.push({
        ...wire,
        from: { ...wire.from, node: `${wire.from.node}-${k}` },
        to: { ...wire.to, node: `${wire.to.node}-${k}` },
      });
    }
  }
  return parseFlow({ nodes, wires, session: base.session });
}

export function largeFlows(): { a: Flow; b: Flow } {
  return { a: cloned(200), b: cloned(150) };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const path = process.argv[2];
  if (path === undefined) throw new Error("usage: save-flows-forever.ts <dbPath>");
  const store = new SqliteFlowStore({ db: openDatabase({ path }) });
  const { a, b } = largeFlows();
  for (;;) {
    for (const flow of [a, b]) {
      writeSync(1, `saved ${store.save(flow).version}\n`);
    }
  }
}
