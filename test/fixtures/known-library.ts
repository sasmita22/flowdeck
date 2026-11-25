import type { BlueprintKind, LibraryLookup } from "../../src/core/flow/libraries.js";

const knownLibraries: Record<string, { name: string; uses: string[] }> = {
  "known-library": { name: "Known", uses: [] },
  "loop-a": { name: "Loop A", uses: ["loop-b"] },
  "loop-b": { name: "Loop B", uses: ["loop-a"] },
};

export const knownLibrary: LibraryLookup = (flowId) => {
  const library = knownLibraries[flowId];
  return library === undefined
    ? undefined
    : { name: library.name, kind: "node-library", sessions: [], uses: library.uses };
};

export const libraryOf =
  (kinds: Record<string, BlueprintKind>): LibraryLookup =>
  (flowId) => {
    const kind = kinds[flowId];
    return kind === undefined ? undefined : { name: flowId, kind, sessions: [], uses: [] };
  };
