import Database from "better-sqlite3";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";

const migrationsDir = fileURLToPath(
  new URL("../../../src/adapters/sqlite/migrations/", import.meta.url),
);

type StoredNode = { type: string; settings: Record<string, unknown> };

type World = {
  id: string;
  versions: StoredNode[][];
  buildNodes: StoredNode[];
  manifest: StoredNode[];
  runManifest?: StoredNode[];
  snapshot: StoredNode[];
  attempt?: StoredNode[];
};

const agent: StoredNode = { type: "agent", settings: { instructions: "Fix it" } };
const alwaysGate: StoredNode = {
  type: "gate",
  settings: { stopWhen: "always", condition: "", instruction: "Look" },
};
const conditionalGate: StoredNode = {
  type: "gate",
  settings: { stopWhen: "conditional", condition: "tests fail", instruction: "Report" },
};
const oldGate: StoredNode = { type: "gate", settings: { shown: "Plan", skippable: false } };

const current = [agent, alwaysGate, conditionalGate];
const holding = (node: StoredNode) => [agent, node];

const flowJson = (nodes: StoredNode[]) =>
  JSON.stringify({
    nodes: nodes.map((node, index) => ({ id: `n${index}`, ...node })),
  });

const manifestJson = (nodes: StoredNode[]) =>
  JSON.stringify({
    version: 1,
    containers: [
      { kind: "workspace", nodes: [] },
      { kind: "session", nodes: nodes.map((node, index) => ({ id: `n${index}`, ...node })) },
    ],
    files: {},
  });

function seed(db: Database.Database, world: World): void {
  const { id } = world;
  const build = `${id}-b`;
  const pending = `${id}-p`;
  const run = `${id}-r`;
  db.transaction(() => {
    db.prepare("INSERT INTO flows (id, name, created_at) VALUES (?, ?, '2026-01-01')").run(id, id);
    for (const [index, nodes] of world.versions.entries()) {
      const version = index + 1;
      for (const [ordinal, node] of nodes.entries()) {
        db.prepare(
          `INSERT INTO nodes (flow_id, version, ordinal, id, type, label, x, y, parent, settings)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, ?)`,
        ).run(
          id,
          version,
          ordinal,
          `n${ordinal}`,
          node.type,
          node.type,
          JSON.stringify(node.settings),
        );
        db.prepare(
          `INSERT INTO ports (flow_id, version, node_id, ordinal, name, direction, kind)
           VALUES (?, ?, ?, 0, 'in', 'in', 'then')`,
        ).run(id, version, `n${ordinal}`);
      }
      db.prepare(
        `INSERT INTO wires (flow_id, version, ordinal, kind, from_node, from_port, to_node, to_port)
         VALUES (?, ?, 0, 'then', 'n0', 'out', 'n1', 'in')`,
      ).run(id, version);
      db.prepare(
        `INSERT INTO flow_versions (flow_id, version, session, saved_at)
         VALUES (?, ?, 'main', '2026-01-01')`,
      ).run(id, version);
    }

    for (const [ordinal, node] of world.buildNodes.entries()) {
      db.prepare(
        `INSERT INTO build_nodes (build_id, ordinal, node_id, type, config, file)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(build, ordinal, `n${ordinal}`, node.type, JSON.stringify(node.settings));
    }
    db.prepare("INSERT INTO build_files (build_id, path, sha256) VALUES (?, 'a.md', 'x')").run(
      build,
    );
    db.prepare(
      `INSERT INTO builds (id, hash, name, dir, created_at, flow_id, version)
       VALUES (?, ?, ?, '/fd/b', 1, ?, 1)`,
    ).run(build, build, build, id);
    db.prepare("INSERT INTO build_manifests (build_id, manifest_json) VALUES (?, ?)").run(
      build,
      manifestJson(world.manifest),
    );
    db.prepare(
      `INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at, ended_at, outcome, build_id)
       VALUES (?, ?, 1, ?, '{}', 1, 2, 'built', ?)`,
    ).run(pending, id, build, build);
    db.prepare(
      `INSERT INTO build_snapshots (pending_id, build_id, blueprint_name, version, svg, flow_json, created_at)
       VALUES (?, ?, ?, 1, '<svg/>', ?, 1)`,
    ).run(pending, build, id, flowJson(world.snapshot));
    for (const table of ["build_events", "build_activity"]) {
      db.prepare(
        `INSERT INTO ${table} (pending_id, seq, at, body_json) VALUES (?, 1, 1, '{}')`,
      ).run(pending);
    }
    db.prepare(
      `INSERT INTO build_step_texts (pending_id, entry_id, field, text, at)
       VALUES (?, 1, 'input', 'x', 1)`,
    ).run(pending);
    db.prepare(
      `INSERT INTO build_worktrees (build_id, container, repo, base, branch, branch_created, path)
       VALUES (?, 'main', '/repo', 'main', 'b', 1, '/wt')`,
    ).run(build);
    db.prepare("INSERT INTO run_number_counters (build_id, last) VALUES (?, 1)").run(build);

    if (world.attempt !== undefined) {
      const attempt = `${id}-a`;
      db.prepare(
        `INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at, ended_at, outcome)
         VALUES (?, ?, 1, ?, '{}', 1, 2, 'failed')`,
      ).run(attempt, id, attempt);
      db.prepare(
        `INSERT INTO build_snapshots (pending_id, build_id, blueprint_name, version, svg, flow_json, created_at)
         VALUES (?, NULL, ?, 1, '<svg/>', ?, 1)`,
      ).run(attempt, id, flowJson(world.attempt));
      db.prepare(
        `INSERT INTO build_events (pending_id, seq, at, body_json) VALUES (?, 1, 1, '{}')`,
      ).run(attempt);
    }

    db.prepare(
      `INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id, manifest_json, number)
       VALUES (?, '/fd/b', '{}', 'done', '2026-01-01', ?, ?, 1)`,
    ).run(run, build, manifestJson(world.runManifest ?? world.manifest));
    const session = db
      .prepare(
        `INSERT INTO run_sessions (run_id, tmux_name, cwd, claude_session_id, status)
         VALUES (?, 'fd-x', '/wt', 's', 'closed')`,
      )
      .run(run).lastInsertRowid;
    db.prepare("INSERT INTO run_nodes (run_id, node_id, session_id) VALUES (?, 'n0', ?)").run(
      run,
      session,
    );
    db.prepare(
      `INSERT INTO events (run_id, node_id, kind, payload, time)
       VALUES (?, 'n0', 'done', NULL, '2026-01-01')`,
    ).run(run);
    db.prepare("INSERT INTO activity (run_id, id, node_id, entry) VALUES (?, 1, 'n0', '{}')").run(
      run,
    );
    db.prepare(
      `INSERT INTO run_stories (run_id, at, run_status, text, cost) VALUES (?, '2026-01-01', 'done', 'x', 0)`,
    ).run(run);
    db.prepare(
      `INSERT INTO run_repo_states (run_id, phase, state_json, other_repos_json, at)
       VALUES (?, 'before', '{}', '[]', 1)`,
    ).run(run);
    db.prepare(
      `INSERT INTO step_texts (run_id, entry_id, field, text, at) VALUES (?, 1, 'input', 'x', 1)`,
    ).run(run);
  })();
}

function rowsOf(db: Database.Database, id: string): Record<string, number> {
  const keys: [string, string, string][] = [
    ["flows", "id", id],
    ["flow_versions", "flow_id", id],
    ["nodes", "flow_id", id],
    ["ports", "flow_id", id],
    ["wires", "flow_id", id],
    ["builds", "id", `${id}-b`],
    ["build_nodes", "build_id", `${id}-b`],
    ["build_files", "build_id", `${id}-b`],
    ["build_manifests", "build_id", `${id}-b`],
    ["build_worktrees", "build_id", `${id}-b`],
    ["run_number_counters", "build_id", `${id}-b`],
    ["pending_builds", "flow_id", id],
    ["build_snapshots", "blueprint_name", id],
    ["build_events", "pending_id", `${id}-p`],
    ["build_activity", "pending_id", `${id}-p`],
    ["build_step_texts", "pending_id", `${id}-p`],
    ["runs", "id", `${id}-r`],
    ["run_sessions", "run_id", `${id}-r`],
    ["run_nodes", "run_id", `${id}-r`],
    ["events", "run_id", `${id}-r`],
    ["activity", "run_id", `${id}-r`],
    ["run_stories", "run_id", `${id}-r`],
    ["run_repo_states", "run_id", `${id}-r`],
    ["step_texts", "run_id", `${id}-r`],
  ];
  return Object.fromEntries(
    keys.map(([table, column, value]) => [
      table,
      (
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
          n: number;
        }
      ).n,
    ]),
  );
}

const refusedByTrigger = (write: () => unknown) => {
  let code: string | undefined;
  try {
    write();
  } catch (error) {
    if (error instanceof Database.SqliteError) code = error.code;
    else throw error;
  }
  expect(code).toBe("SQLITE_CONSTRAINT_TRIGGER");
};

const deleteBuildOf = (id: string) => (db: Database.Database) => {
  for (const table of ["build_step_texts", "build_activity", "build_events"]) {
    db.prepare(`DELETE FROM ${table} WHERE pending_id = ?`).run(`${id}-p`);
  }
  db.prepare("DELETE FROM build_snapshots WHERE build_id = ?").run(`${id}-b`);
  db.prepare("DELETE FROM pending_builds WHERE build_id = ?").run(`${id}-b`);
  for (const table of [
    "build_nodes",
    "build_files",
    "build_manifests",
    "run_number_counters",
    "build_worktrees",
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE build_id = ?`).run(`${id}-b`);
  }
  db.prepare("DELETE FROM builds WHERE id = ?").run(`${id}-b`);
};

describe("dropping stored rows that hold a removed node type or an old-settings Gate", () => {
  let folder: string;
  const opened: Database.Database[] = [];

  const stage = async (before: string) => {
    const dir = join(folder, `before-${before}`);
    await mkdir(dir);
    for (const file of (await readdir(migrationsDir)).filter((each) => each < before)) {
      await copyFile(join(migrationsDir, file), join(dir, file));
    }
    return dir;
  };

  const migrated = async (worlds: World[], afterSeed?: (db: Database.Database) => void) => {
    const path = join(folder, "flowdeck.db");
    const old = openDatabase({ path, migrationsDir: await stage("028") });
    for (const world of worlds) seed(old, world);
    afterSeed?.(old);
    const before = Object.fromEntries(worlds.map((world) => [world.id, rowsOf(old, world.id)]));
    old.close();
    const db = openDatabase({ path });
    opened.push(db);
    return { db, before };
  };

  const none = (counts: Record<string, number>) =>
    Object.fromEntries(Object.keys(counts).map((table) => [table, 0]));

  const blueprintKept = {
    flows: 1,
    flow_versions: 1,
    nodes: current.length,
    ports: current.length,
    wires: 1,
  };

  const kept: World = {
    id: "kept",
    versions: [current],
    buildNodes: current,
    manifest: current,
    snapshot: current,
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-drop-gates-"));
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it.each<[string, StoredNode]>([
    ["an Ask node", { type: "ask", settings: { question: "Ship?" } }],
    ["a Hard stop node", { type: "hardstop", settings: { condition: "tests fail" } }],
    ["a Gate with the old settings", oldGate],
    [
      "a Gate that still has skippable",
      { type: "gate", settings: { ...alwaysGate.settings, skippable: true } },
    ],
    [
      "a Gate that still has shown",
      { type: "gate", settings: { ...alwaysGate.settings, shown: "" } },
    ],
    ["a Gate with no stopWhen", { type: "gate", settings: { condition: "", instruction: "" } }],
  ])("removes a blueprint, its build and that build's run when they hold %s", async (_, node) => {
    const gone: World = {
      id: "gone",
      versions: [holding(node)],
      buildNodes: holding(node),
      manifest: holding(node),
      snapshot: holding(node),
    };

    const { db, before } = await migrated([kept, gone]);

    expect(before.gone).not.toEqual(none(before.gone ?? {}));
    expect(rowsOf(db, "gone")).toEqual(none(before.gone ?? {}));
    expect(rowsOf(db, "kept")).toEqual(before.kept);
  });

  it("removes a blueprint with every version when only a later version holds an old-settings Gate", async () => {
    const later: World = {
      id: "later",
      versions: [current, holding(oldGate)],
      buildNodes: current,
      manifest: current,
      snapshot: current,
    };

    const { db } = await migrated([kept, later]);

    expect(rowsOf(db, "later")).toMatchObject({ flows: 0, flow_versions: 0, nodes: 0 });
  });

  it.each([
    ["its build nodes", { buildNodes: holding(oldGate), manifest: current, snapshot: current }],
    [
      "its manifest",
      { buildNodes: current, manifest: holding(oldGate), runManifest: current, snapshot: current },
    ],
    ["its snapshot flow", { buildNodes: current, manifest: current, snapshot: holding(oldGate) }],
  ])("removes a build and its run when only %s holds an old-settings Gate", async (_, holds) => {
    const build: World = { id: "build", versions: [current], ...holds };

    const { db, before } = await migrated([kept, build]);

    expect(rowsOf(db, "build")).toEqual({ ...none(before.build ?? {}), ...blueprintKept });
  });

  it("removes a run whose build was deleted when only the run's manifest holds an old-settings Gate", async () => {
    const orphan: World = {
      id: "orphan",
      versions: [current],
      buildNodes: current,
      manifest: current,
      runManifest: holding(oldGate),
      snapshot: current,
    };

    const { db, before } = await migrated([kept, orphan], deleteBuildOf("orphan"));

    expect(before.orphan).toMatchObject({ builds: 0, build_manifests: 0, runs: 1, events: 1 });
    expect(rowsOf(db, "orphan")).toEqual({ ...none(before.orphan ?? {}), ...blueprintKept });
    expect(rowsOf(db, "kept")).toEqual(before.kept);
  });

  it("removes a failed build attempt whose snapshot flow holds an old-settings Gate", async () => {
    const attempt: World = { ...kept, id: "attempt", attempt: holding(oldGate) };

    const { db } = await migrated([kept, attempt]);

    expect(
      db
        .prepare("SELECT id FROM pending_builds WHERE flow_id = 'attempt' ORDER BY id")
        .pluck()
        .all(),
    ).toEqual(["attempt-p"]);
    expect(
      db.prepare("SELECT count(*) FROM build_events WHERE pending_id = 'attempt-a'").pluck().get(),
    ).toBe(0);
  });

  it("keeps every row of a blueprint, build and run holding only new-shape Gates and other types", async () => {
    const gone: World = {
      id: "gone",
      versions: [holding(oldGate)],
      buildNodes: holding(oldGate),
      manifest: holding(oldGate),
      snapshot: holding(oldGate),
    };

    const { db, before } = await migrated([kept, gone]);

    expect(before.kept).toMatchObject(blueprintKept);
    expect(rowsOf(db, "kept")).toEqual(before.kept);
  });

  it.each(["wires", "ports", "nodes", "flow_versions"])(
    "still refuses deleting a saved %s row afterwards",
    async (table) => {
      const { db } = await migrated([kept]);

      refusedByTrigger(() => db.prepare(`DELETE FROM ${table} WHERE flow_id = 'kept'`).run());
      expect(rowsOf(db, "kept")[table]).toBeGreaterThan(0);
    },
  );
});
