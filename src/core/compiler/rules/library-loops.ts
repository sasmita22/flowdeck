import { libraryLoop, libraryLoopReason, unknownLibraries } from "../../flow/libraries.js";
import type { Node } from "../../flow/schema.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "library-loops";

type LibraryNode = Extract<Node, { type: "library" }>;

export const rule: Rule = {
  id,
  message: "A library node's library never reaches back to itself through the libraries it uses.",
  check: (flow, context): ValidationError[] => {
    const libraries = context?.libraries ?? unknownLibraries;
    const nameOf = (libraryId: string) => libraries(libraryId)?.name;
    return flow.nodes
      .filter((node): node is LibraryNode => node.type === "library")
      .flatMap((use): ValidationError[] => {
        const { libraryId } = use.settings;
        const path = libraryLoop((usedId) => libraries(usedId)?.uses, undefined, libraryId);
        return path === undefined
          ? []
          : [
              {
                rule: id,
                node: use.id,
                message: libraryLoopReason(libraryId, path, nameOf),
              },
            ];
      });
  },
};
