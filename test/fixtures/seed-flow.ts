import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { parseFlow } from "../../src/core/flow/schema.js";

export function seedFlow(
  home: string,
  flow: unknown,
  workingFolder?: string,
): { flowId: string; version: number } {
  const parsed = parseFlow(flow);
  const seeded =
    workingFolder === undefined
      ? parsed
      : {
          ...parsed,
          session: {
            ...parsed.session,
            workingFolder: { kind: "path" as const, path: workingFolder },
          },
        };
  const db = openDatabase({ path: `${home}/flowdeck.db` });
  try {
    return new SqliteFlowStore({ db }).save(seeded);
  } finally {
    db.close();
  }
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
