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

  it("reads no manifest once the build is deleted", () => {
    const { runs } = stores();
    runs.recordBuild(newBuild("b1"));

    runs.deleteBuild("b1");

    expect(runs.buildManifest("b1")).toBeUndefined();
  });

  describe("a stored manifest is locked, except for being deleted", () => {
    const manifestRows = (db: Database.Database) =>
      db.prepare("SELECT build_id, manifest_json FROM build_manifests ORDER BY build_id").all();

    it.each([
      ["a change", "UPDATE build_manifests SET manifest_json = '{}'"],
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

    it("lets it be deleted", () => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild("b1"));

      db.exec("DELETE FROM build_manifests");

      expect(manifestRows(db)).toEqual([]);
    });
  });
});
