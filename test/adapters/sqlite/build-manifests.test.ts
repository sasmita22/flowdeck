import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import type { NewBuild } from "../../../src/ports/store.js";

const lockedManifest = '{\n  "version": 1,\n  "hash": "h1",\n  "nodes": []\n}\n';

const newBuild = (id: string, manifest = lockedManifest): NewBuild => ({
  id,
  hash: `hash-${id}`,
  name: `build-${id}`,
  repo: "/repo",
  base: "main",
  branch: `flowdeck/build-${id}`,
  branchCreated: true,
  values: {},
  dir: `/fd/workspaces/${id}`,
  files: [{ path: "manifest.json", sha256: `sha-${id}` }],
  nodes: [],
  manifest,
});

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

describe("build manifests", () => {
  let folder: string;
  const opened: { close(): void }[] = [];

  const stores = () => {
    const db = openDatabase({ path: join(folder, "flowdeck.db") });
    opened.push(db);
    return { db, runs: new SqliteStore({ db, now: () => new Date("2026-03-01T00:00:00Z") }) };
  };

  const lockedBeforeManifests = (
    db: Database.Database,
    id: string,
    options: { manifestSha256?: string; deletedAt?: number } = {},
  ) => {
    db.transaction(() => {
      db.prepare(
        "INSERT INTO build_files (build_id, path, sha256) VALUES (?, 'commands/p1.md', 'c')",
      ).run(id);
      if (options.manifestSha256 !== undefined) {
        db.prepare(
          "INSERT INTO build_files (build_id, path, sha256) VALUES (?, 'manifest.json', ?)",
        ).run(id, options.manifestSha256);
      }
      db.prepare(
        `INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at, deleted_at)
         VALUES (?, ?, ?, '/repo', 'main', '{}', ?, 1, ?)`,
      ).run(id, `hash-${id}`, `build-${id}`, `/fd/workspaces/${id}`, options.deletedAt ?? null);
    })();
  };

  const gaps = (runs: SqliteStore) =>
    runs.listManifestGaps().sort((a, b) => a.buildId.localeCompare(b.buildId));

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-manifests-"));
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("keeps the manifest text a build is recorded with, unchanged", () => {
    const { runs } = stores();

    runs.recordBuild(newBuild("b1"));

    expect(runs.buildManifest("b1")).toBe(lockedManifest);
  });

  it("returns no manifest for an unknown build", () => {
    const { runs } = stores();

    expect(runs.buildManifest("nope")).toBeUndefined();
  });

  it("still reads a build's manifest once the build is deleted", () => {
    const { runs } = stores();
    runs.recordBuild(newBuild("b1"));

    runs.deleteBuild("b1");

    expect(runs.buildManifest("b1")).toBe(lockedManifest);
  });

  describe("storeManifest", () => {
    it("stores the manifest of a build that has none", () => {
      const { db, runs } = stores();
      lockedBeforeManifests(db, "old1", { manifestSha256: "m1" });

      runs.storeManifest({ buildId: "old1", manifest: lockedManifest });

      expect(runs.buildManifest("old1")).toBe(lockedManifest);
    });

    it("leaves a stored manifest as it is, without an error", () => {
      const { runs } = stores();
      runs.recordBuild(newBuild("b1"));

      runs.storeManifest({ buildId: "b1", manifest: '{"version":1,"hash":"other"}' });

      expect(runs.buildManifest("b1")).toBe(lockedManifest);
    });
  });

  describe("a stored manifest is locked", () => {
    const manifestRows = (db: Database.Database) =>
      db.prepare("SELECT build_id, manifest_json FROM build_manifests ORDER BY build_id").all();

    it.each([
      ["a change", "UPDATE build_manifests SET manifest_json = '{}'"],
      ["a deletion", "DELETE FROM build_manifests"],
      [
        "a replacement",
        "INSERT OR REPLACE INTO build_manifests (build_id, manifest_json) VALUES ('b1', '{}')",
      ],
    ])("refuses %s, keeping the row as written", (_what, sql) => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild("b1"));

      refused(() => db.exec(sql));

      expect(manifestRows(db)).toEqual([{ build_id: "b1", manifest_json: lockedManifest }]);
    });
  });

  describe("listManifestGaps", () => {
    it("lists builds with no stored manifest and a manifest file, deleted ones too, with that file's sha256", () => {
      const { db, runs } = stores();
      lockedBeforeManifests(db, "old1", { manifestSha256: "m1" });
      lockedBeforeManifests(db, "gone1", { manifestSha256: "m2", deletedAt: 5 });

      expect(gaps(runs)).toEqual([
        { buildId: "gone1", manifestSha256: "m2" },
        { buildId: "old1", manifestSha256: "m1" },
      ]);
    });

    it("leaves out a build with a stored manifest", () => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild("b1"));
      lockedBeforeManifests(db, "old1", { manifestSha256: "m1" });
      lockedBeforeManifests(db, "old2", { manifestSha256: "m2" });

      runs.storeManifest({ buildId: "old2", manifest: lockedManifest });

      expect(gaps(runs)).toEqual([{ buildId: "old1", manifestSha256: "m1" }]);
    });

    it("leaves out a build with no manifest file", () => {
      const { db, runs } = stores();
      lockedBeforeManifests(db, "bare1");

      expect(gaps(runs)).toEqual([]);
    });
  });
});
