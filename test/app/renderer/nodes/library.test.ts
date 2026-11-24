import { describe, expect, it } from "vitest";
import { libraryCaption } from "../../../../src/app/renderer/nodes/library-caption.js";
import { unknownLibraries, type LibraryLookup } from "../../../../src/core/flow/libraries.js";

const lookup: LibraryLookup = (flowId) =>
  ({
    "f-review": { name: "Review", kind: "node-library" as const, sessions: [], uses: [] },
    "f-android": { name: "Android", kind: "session-library" as const, sessions: [], uses: [] },
  })[flowId];

describe("libraryCaption", () => {
  it.each([
    ["f-review", "Review · Node library"],
    ["f-android", "Android · Session library"],
  ])("names the library %s uses and its kind", (flowId, caption) => {
    expect(libraryCaption(flowId, lookup)).toBe(caption);
  });

  it("says the library is missing when the lookup has no entry", () => {
    expect(libraryCaption("f-gone", lookup)).toBe("Missing library");
    expect(libraryCaption("f-review", unknownLibraries)).toBe("Missing library");
  });

  it("says the library is missing when no library is named", () => {
    expect(libraryCaption(undefined, lookup)).toBe("Missing library");
  });
});
