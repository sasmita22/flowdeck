import type { LibraryLookup } from "../../../core/flow/libraries.js";
import { blueprintKindLabel } from "../library-store.js";

export const libraryCaption = (libraryId: string | undefined, libraries: LibraryLookup): string => {
  const library = libraryId === undefined ? undefined : libraries(libraryId);
  return library === undefined
    ? "Missing library"
    : `${library.name} · ${blueprintKindLabel[library.kind]}`;
};
