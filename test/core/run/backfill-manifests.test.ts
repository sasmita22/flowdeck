import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/core/compiler/hash.js";
import { backfillManifests } from "../../../src/core/run/backfill-manifests.js";
import type { NewBuild } from "../../../src/core/run/store.js";
import { FakeStore } from "../../fakes/fake-store.js";

const manifestOf = (id: string) =>
  JSON.stringify({ version: 1, hash: `hash-${id}`, session: { name: "main" }, nodes: [] });

const lockedBeforeManifests = (
  id: string,
  manifestSha256 = sha256Hex(manifestOf(id)),
): Omit<NewBuild, "manifest"> => ({
  id,
  hash: `hash-${id}`,
  name: `build-${id}`,
  repo: "/repo",
  base: "main",
  branch: `flowdeck/build-${id}`,
  branchCreated: true,
  values: {},
  dir: `/fd/workspaces/${id}`,
  files: [{ path: "manifest.json", sha256: manifestSha256 }],
  nodes: [],
});

describe("backfillManifests", () => {
  let store: FakeStore;
  let reads: string[];
  let onDisk: Map<string, string>;

  const readManifest = async (buildId: string) => {
    reads.push(buildId);
    return onDisk.get(buildId);
  };

  beforeEach(() => {
    store = new FakeStore();
    reads = [];
    onDisk = new Map();
  });

  it("stores the manifest of a build locked before manifests were kept when it matches its sha256", async () => {
    store.recordBuildWithoutManifest(lockedBeforeManifests("b1"));
    onDisk.set("b1", manifestOf("b1"));

    await backfillManifests({ store, readManifest, sha256: sha256Hex });

    expect(store.buildManifest("b1")).toBe(manifestOf("b1"));
    expect(store.listManifestGaps()).toEqual([]);
  });

  it("skips a build whose folder is gone and still stores the builds after it", async () => {
    store.recordBuildWithoutManifest(lockedBeforeManifests("gone"));
    store.recordBuildWithoutManifest(lockedBeforeManifests("b2"));
    onDisk.set("b2", manifestOf("b2"));

    await backfillManifests({ store, readManifest, sha256: sha256Hex });

    expect(reads).toEqual(["gone", "b2"]);
    expect(store.buildManifest("gone")).toBeUndefined();
    expect(store.buildManifest("b2")).toBe(manifestOf("b2"));
  });

  it("skips a build whose read rejects and still stores the builds after it", async () => {
    store.recordBuildWithoutManifest(lockedBeforeManifests("unreadable"));
    store.recordBuildWithoutManifest(lockedBeforeManifests("b2"));
    onDisk.set("b2", manifestOf("b2"));
    const rejecting = async (buildId: string) => {
      if (buildId === "unreadable") throw new Error("EACCES");
      return readManifest(buildId);
    };

    await backfillManifests({ store, readManifest: rejecting, sha256: sha256Hex });

    expect(store.buildManifest("unreadable")).toBeUndefined();
    expect(store.buildManifest("b2")).toBe(manifestOf("b2"));
  });

  it("skips a manifest that no longer matches the sha256 it was locked with", async () => {
    store.recordBuildWithoutManifest(lockedBeforeManifests("edited"));
    store.recordBuildWithoutManifest(lockedBeforeManifests("b2"));
    onDisk.set("edited", `${manifestOf("edited")}\n`);
    onDisk.set("b2", manifestOf("b2"));

    await backfillManifests({ store, readManifest, sha256: sha256Hex });

    expect(store.buildManifest("edited")).toBeUndefined();
    expect(store.listManifestGaps().map((gap) => gap.buildId)).toEqual(["edited"]);
    expect(store.buildManifest("b2")).toBe(manifestOf("b2"));
  });

  it("does not read a build that already has its manifest", async () => {
    store.recordBuild({ ...lockedBeforeManifests("kept"), manifest: manifestOf("kept") });
    store.recordBuildWithoutManifest(lockedBeforeManifests("b2"));
    onDisk.set("kept", manifestOf("other"));
    onDisk.set("b2", manifestOf("b2"));

    await backfillManifests({ store, readManifest, sha256: sha256Hex });

    expect(reads).toEqual(["b2"]);
    expect(store.buildManifest("kept")).toBe(manifestOf("kept"));
  });
});
