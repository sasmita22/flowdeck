import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { parseFlow } from "../../src/core/flow/schema.js";

const inRepo = (flow: unknown, repo: string | undefined) => {
  const parsed = parseFlow(flow);
  return repo === undefined
    ? parsed
    : {
        ...parsed,
        session: {
          ...parsed.session,
          buildConfig: { ...parsed.session.buildConfig, repo },
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
  repo?: string,
): { flowId: string; version: number } {
  return withStore(home, (store) => store.save(inRepo(flow, repo)));
}

export function seedBlueprint(
  home: string,
  name: string,
  flow: unknown,
  repo?: string,
): { flowId: string; version: number } {
  return withStore(home, (store) => store.save(inRepo(flow, repo), store.create(name).flowId));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const [home, flowPath, repo] = process.argv.slice(2);
  if (home === undefined || flowPath === undefined) {
    throw new Error("usage: seed-flow.ts <home> <flow.json> [<repo>]");
  }
  const { version } = seedFlow(home, JSON.parse(readFileSync(flowPath, "utf8")), repo);
  writeSync(1, `seeded ${version}\n`);
}
