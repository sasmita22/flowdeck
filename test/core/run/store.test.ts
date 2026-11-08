import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import type { NewBuild, Store } from "../../../src/core/run/store.js";
import { FakeStore } from "../../fakes/fake-store.js";

const build = (id: string, name: string): NewBuild => ({
  id,
  hash: `hash-${id}`,
  name,
  repo: "/repos/app",
  base: "main",
  values: { ticket: "FD-1" },
  dir: `/fd/workspaces/${id}`,
  files: [],
  nodes: [],
});

const deletedAtTime = Date.UTC(2026, 0, 2);

describe.each([
  ["SqliteStore", "sqlite"],
  ["FakeStore", "fake"],
] as const)("%s listBuildsWithDeleted", (_name, kind) => {
  let folder: string;
  let opened: SqliteStore[];

  const open = (): Store => {
    const now = () => new Date(deletedAtTime);
    if (kind === "fake") return new FakeStore({ now });
    const store = new SqliteStore({ path: join(folder, "flowdeck.db"), now });
    opened.push(store);
    return store;
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-store-"));
    opened = [];
  });

  afterEach(async () => {
    for (const store of opened) store.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("returns live and deleted builds, with deletedAt set only on the deleted ones", () => {
    const store = open();
    store.recordBuild(build("live1234", "keep"));
    store.recordBuild(build("gone1234", "gone"));
    store.deleteBuild("gone1234");

    const listed = store.listBuildsWithDeleted();

    expect(listed.map(({ id }) => id).sort()).toEqual(["gone1234", "live1234"]);
    expect(listed.find(({ id }) => id === "live1234")).toMatchObject({
      name: "keep",
      deletedAt: null,
    });
    expect(listed.find(({ id }) => id === "gone1234")).toMatchObject({
      name: "gone",
      deletedAt: deletedAtTime,
    });
  });

  it("leaves listBuilds without the deleted builds", () => {
    const store = open();
    store.recordBuild(build("live1234", "keep"));
    store.recordBuild(build("gone1234", "gone"));
    store.deleteBuild("gone1234");

    expect(store.listBuilds().map(({ id }) => id)).toEqual(["live1234"]);
  });
});
