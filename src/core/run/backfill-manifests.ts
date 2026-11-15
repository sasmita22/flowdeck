import type { ManifestGap, Store } from "./store.js";

export type BackfillManifestsDeps = {
  store: Pick<Store, "listManifestGaps" | "storeManifest">;
  readManifest: (buildId: string) => Promise<string | undefined>;
  sha256: (text: string) => string;
};

export type ManifestBackfillFailure = { gap: ManifestGap; error: unknown };

export async function backfillManifests({
  store,
  readManifest,
  sha256,
}: BackfillManifestsDeps): Promise<ManifestBackfillFailure[]> {
  const failures: ManifestBackfillFailure[] = [];
  for (const gap of store.listManifestGaps()) {
    try {
      const manifest = await readManifest(gap.buildId);
      if (manifest !== undefined && sha256(manifest) === gap.manifestSha256) {
        store.storeManifest({ buildId: gap.buildId, manifest });
      }
    } catch (error) {
      failures.push({ gap, error });
    }
  }
  return failures;
}
