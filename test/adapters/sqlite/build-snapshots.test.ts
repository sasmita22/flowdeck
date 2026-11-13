import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { flowSvg } from "../../../src/core/flow/flow-svg.js";
import { backfillSnapshots } from "../../../src/core/run/backfill-snapshots.js";
import type { NewBuild } from "../../../src/ports/store.js";
import { agent, flow } from "../../fixtures/flow-builders.js";

const savedFlow = flow([agent("a1")], []);

const newBuild: NewBuild = {
  id: "b1",
  hash: "h1",
  name: "fix-login",
  repo: "/repo",
  base: "main",
  values: {},
  dir: "/fd/workspaces/b1",
  files: [],
  nodes: [],
};

const copyRow = (db: Database.Database, pendingId: string | null, buildId: string | null) =>
  db
    .prepare(
      `INSERT INTO build_snapshots (id, pending_id, build_id, blueprint_name, version, flow_json, svg, created_at)
       SELECT CASE typeof(id) WHEN 'integer' THEN (SELECT max(id) + 1 FROM build_snapshots)
                              ELSE lower(hex(randomblob(16))) END,
              ?, ?, blueprint_name, version, flow_json, svg, created_at
         FROM build_snapshots LIMIT 1`,
    )
    .run(pendingId, buildId);

const refused = (write: () => unknown) => {
  let code: string | undefined;
  try {
    write();
  } catch (error) {
    if (error instanceof Database.SqliteError) code = error.code;
    else throw error;
  }
  expect(code).toMatch(/^SQLITE_CONSTRAINT/);
};

describe("build snapshots", () => {
  let folder: string;
  const opened: { close(): void }[] = [];

  const stores = () => {
    const db = openDatabase({ path: join(folder, "flowdeck.db") });
    opened.push(db);
    return { db, runs: new SqliteStore({ db, now: () => new Date("2026-03-01T00:00:00Z") }) };
  };

  const seeded = () => {
    const { db, runs } = stores();
    const start = runs.startPendingBuild({
      flowId: "flow-1",
      version: 1,
      name: "fix-login",
      origin: {
        source: { flowId: "flow-1", version: 1 },
        blueprint: { name: "Report", version: 1 },
      },
      startedAt: 1_000,
      snapshot: { blueprintName: "Report", version: 1, flow: savedFlow, svg: flowSvg(savedFlow) },
    });
    if (start.kind !== "started") throw new Error(`expected a start, got ${start.reason}`);
    return { db, runs, pendingId: start.pendingId };
  };

  const rows = (db: Database.Database) =>
    db
      .prepare(
        "SELECT pending_id, build_id, blueprint_name, version, flow_json, svg, created_at FROM build_snapshots ORDER BY rowid",
      )
      .all();

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-snapshots-"));
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  describe("a snapshot is append-only", () => {
    it("refuses a change to its flow and its deletion, keeping the row as written", () => {
      const { db } = seeded();
      const before = rows(db);

      refused(() => db.prepare("UPDATE build_snapshots SET flow_json = '{}'").run());
      refused(() => db.prepare("DELETE FROM build_snapshots").run());

      expect(before).toHaveLength(1);
      expect(rows(db)).toEqual(before);
    });

    it("lets its build id be set once from none, and refuses a second change to it", () => {
      const { db, pendingId } = seeded();

      db.prepare("UPDATE build_snapshots SET build_id = 'b1' WHERE pending_id = ?").run(pendingId);

      expect(rows(db)).toMatchObject([{ pending_id: pendingId, build_id: "b1" }]);
      refused(() => db.prepare("UPDATE build_snapshots SET build_id = 'b2'").run());
      refused(() => db.prepare("UPDATE build_snapshots SET build_id = NULL").run());
      expect(rows(db)).toMatchObject([{ pending_id: pendingId, build_id: "b1" }]);
    });

    it.each([
      ["pending_id", "'other'"],
      ["blueprint_name", "'Other'"],
      ["version", "9"],
      ["flow_json", "'{}'"],
      ["svg", "'<svg/>'"],
      ["created_at", "9"],
    ])("refuses setting the build id together with %s", (column, value) => {
      const { db } = seeded();
      const before = rows(db);

      refused(() =>
        db.prepare(`UPDATE build_snapshots SET build_id = 'b1', ${column} = ${value}`).run(),
      );
      expect(rows(db)).toEqual(before);
    });

    it("refuses a second row for a pending id or a build id, and a row with neither", () => {
      const { db, pendingId } = seeded();
      db.prepare("UPDATE build_snapshots SET build_id = 'b1' WHERE pending_id = ?").run(pendingId);

      copyRow(db, "other-pending", "b9");

      refused(() => copyRow(db, pendingId, null));
      refused(() => copyRow(db, null, "b1"));
      refused(() => copyRow(db, null, null));
      expect(rows(db)).toMatchObject([
        { pending_id: pendingId, build_id: "b1" },
        { pending_id: "other-pending", build_id: "b9" },
      ]);
    });
  });

  it("keeps a build's snapshot readable once the build is deleted", () => {
    const { db, runs, pendingId } = seeded();
    runs.recordBuild(newBuild);
    runs.endPendingBuild(pendingId, { outcome: "built", endedAt: 2_000, buildId: "b1" });

    runs.deleteBuild("b1");

    expect(
      db.prepare("SELECT pending_id, build_id FROM build_snapshots WHERE build_id = 'b1'").all(),
    ).toEqual([{ pending_id: pendingId, build_id: "b1" }]);
  });

  it("lets a second Flowdeck's backfill leave a just-recorded build to its own pending snapshot", () => {
    const first = stores();
    const { flowId, version } = new SqliteFlowStore({ db: first.db }).save(savedFlow, {
      name: "Report",
    });
    const pendingSnapshot = {
      blueprintName: "Report",
      version,
      flow: savedFlow,
      svg: flowSvg(savedFlow),
    };
    const start = first.runs.startPendingBuild({
      flowId,
      version,
      name: "fix-login",
      origin: { source: { flowId, version }, blueprint: { name: "Report", version } },
      startedAt: 1_000,
      snapshot: pendingSnapshot,
    });
    if (start.kind !== "started") throw new Error(`expected a start, got ${start.reason}`);
    first.runs.recordBuild({ ...newBuild, source: { flowId, version } });
    const second = stores();

    const backfilled = backfillSnapshots({
      store: second.runs,
      flows: new SqliteFlowStore({ db: second.db }),
    });
    first.runs.endPendingBuild(start.pendingId, {
      outcome: "built",
      endedAt: 2_000,
      buildId: "b1",
    });

    expect(first.runs.pendingBuild(start.pendingId)?.endedAt).toBe(2_000);
    expect(backfilled).toEqual({ added: 0, failures: [] });
    expect(second.runs.buildSnapshot({ buildId: "b1" })).toEqual({
      ...pendingSnapshot,
      pendingId: start.pendingId,
      buildId: "b1",
    });
  });

  it("records a build naming a flow version that was never saved", () => {
    const { db } = stores();

    db.prepare(
      `INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at, flow_id, version)
       VALUES ('b1', 'h1', 'fix-login', '/repo', 'main', '{}', '/fd/workspaces/b1', 1, 'nope', 3)`,
    ).run();

    expect(db.prepare("SELECT flow_id, version FROM builds").all()).toEqual([
      { flow_id: "nope", version: 3 },
    ]);
  });
});
