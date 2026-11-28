import type { BlueprintKind, LibraryLookup } from "../../src/core/flow/libraries.js";

const knownLibraries: Record<string, { name: string; uses: string[]; sends: string[] }> = {
  "known-library": { name: "Known", uses: [], sends: [] },
  "loop-a": { name: "Loop A", uses: ["loop-b"], sends: [] },
  "loop-b": { name: "Loop B", uses: ["loop-a"], sends: [] },
  "sending-library": { name: "Sending", uses: [], sends: ["approved"] },
};

export const knownLibrary: LibraryLookup = (flowId) => {
  const library = knownLibraries[flowId];
  return library === undefined
    ? undefined
    : {
        name: library.name,
        kind: "node-library",
        sessions: [],
        uses: library.uses,
        sends: library.sends,
      };
};

export const libraryOf =
  (kinds: Record<string, BlueprintKind>): LibraryLookup =>
  (flowId) => {
    const kind = kinds[flowId];
    return kind === undefined
      ? undefined
      : { name: flowId, kind, sessions: [], uses: [], sends: [] };
  };
