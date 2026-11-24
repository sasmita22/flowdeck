import { reasonNaming } from "../compiler/problems.js";
import { validate } from "../compiler/validate.js";
import { labelFor } from "../nodes/defaults.js";
import { newProblems } from "./blueprint-edits.js";
import { libraryLoop, loopReason, type LibraryLookup } from "./libraries.js";
import type { Flow } from "./schema.js";
import { flowContainerName } from "./structure.js";

export const loopRefusal = (
  libraries: LibraryLookup,
  openFlowId: string | null,
  libraryId: string,
): string | undefined => {
  const path = libraryLoop((id) => libraries(id)?.uses, openFlowId ?? undefined, libraryId);
  return path && loopReason(path, (id) => libraries(id)?.name);
};

export const labelIn = (flow: Flow, id: string): string => {
  const container = flow.containers.find((candidate) => candidate.id === id);
  if (container !== undefined) return flowContainerName(container);
  const node = flow.nodes.find((candidate) => candidate.id === id);
  return node === undefined ? id : labelFor(node);
};

export function libraryRefusal({
  before,
  after,
  nodeId,
  libraryId,
  libraries,
  openFlowId,
}: {
  before: Flow;
  after: Flow;
  nodeId: string;
  libraryId: string;
  libraries: LibraryLookup;
  openFlowId: string | null;
}): string | undefined {
  const loop = loopRefusal(libraries, openFlowId, libraryId);
  if (loop !== undefined) return loop;
  const [refused] = [
    ...newProblems(before, after, libraries).filter(({ rule }) => rule === "body-nodes"),
    ...validate(after, libraries).filter(
      (error) => error.rule === "library-use" && error.node === nodeId,
    ),
  ];
  return refused && reasonNaming(refused.node, refused.message, labelIn(after, refused.node ?? ""));
}
