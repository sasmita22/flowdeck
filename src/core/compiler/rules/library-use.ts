import { unknownLibraries } from "../../flow/libraries.js";
import type { Flow, Node } from "../../flow/schema.js";
import { flowContainerOf } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "library-use";

type LibraryNode = Extract<Node, { type: "library" }>;

function placementProblem(flow: Flow, use: LibraryNode, sessionLibrary: boolean) {
  const container = flowContainerOf(flow, use.id);
  if (sessionLibrary && container !== undefined) {
    return "is a session library, so it cannot sit inside the workspace or a session";
  }
  return undefined;
}

export const rule: Rule = {
  id,
  message:
    "A library node names an existing node or session library, and sits where that kind of library fits.",
  check: (flow, context): ValidationError[] => {
    const libraries = context?.libraries ?? unknownLibraries;
    return flow.nodes
      .filter((node): node is LibraryNode => node.type === "library")
      .flatMap((use): ValidationError[] => {
        const { label, libraryId } = use.settings;
        const library = libraries(libraryId);
        if (library === undefined) {
          return [
            {
              rule: id,
              node: use.id,
              message: `${label} names a blueprint that no longer exists.`,
            },
          ];
        }
        if (library.kind === "workflow" || library.kind === "incomplete") {
          return [
            {
              rule: id,
              node: use.id,
              message: `${label} names "${library.name}", which is ${library.kind === "workflow" ? "a workflow" : "incomplete"}; only node and session libraries can be used.`,
            },
          ];
        }
        const problem = placementProblem(flow, use, library.kind === "session-library");
        return problem === undefined
          ? []
          : [{ rule: id, node: use.id, message: `"${library.name}" ${problem}.` }];
      });
  },
};
