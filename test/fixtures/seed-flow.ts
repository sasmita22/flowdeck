import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { parseFlow } from "../../src/core/flow/schema.js";

const inFolder = (flow: unknown, workingFolder: string | undefined) => {
  const parsed = parseFlow(flow);
  return workingFolder === undefined
    ? parsed
    : {
        ...parsed,
        session: {
          ...parsed.session,
          workingFolder: { kind: "path" as const, path: workingFolder },
        },
      };
};

const withStore = <T>(home: string, use: (store: SqliteFlowStore) => T): T => {
  const db = openDatabase({ path: `${home}/flowdeck.db` });
  try {
    return use(new SqliteFlowStore({ db }));
  } finally {
    db.close();
  }
};

export function seedFlow(
  home: string,
  flow: unknown,
  workingFolder?: string,
): { flowId: string; version: number } {
  return withStore(home, (store) => store.save(inFolder(flow, workingFolder)));
}

export function seedBlueprint(
  home: string,
  name: string,
  flow: unknown,
  workingFolder?: string,
): { flowId: string; version: number } {
  return withStore(home, (store) =>
    store.save(inFolder(flow, workingFolder), store.create(name).flowId),
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const [home, flowPath, workingFolder] = process.argv.slice(2);
  if (home === undefined || flowPath === undefined) {
    throw new Error("usage: seed-flow.ts <home> <flow.json> [<workingFolder>]");
  }
  const { version } = seedFlow(home, JSON.parse(readFileSync(flowPath, "utf8")), workingFolder);
  writeSync(1, `seeded ${version}\n`);
}
