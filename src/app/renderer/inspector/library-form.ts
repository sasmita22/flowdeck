import type { LibrarySession } from "../../../core/flow/libraries.js";
import type { Node } from "../../../core/flow/schema.js";
import type { LibraryOverrideField } from "../test-ids.js";

export type LibraryNode = Extract<Node, { type: "library" }>;

type Override = LibraryNode["settings"]["overrides"][string];

export const renamedLibrary = (node: LibraryNode, label: string): LibraryNode => ({
  ...node,
  label,
  settings: { ...node.settings, label },
});

export const sessionValue = (
  node: LibraryNode,
  session: LibrarySession,
  field: LibraryOverrideField,
): string => node.settings.overrides[session.id]?.[field] ?? session[field];

export function overriddenLibrary(
  node: LibraryNode,
  session: LibrarySession,
  field: LibraryOverrideField,
  value: string,
): LibraryNode {
  const { [session.id]: current = {}, ...others } = node.settings.overrides;
  const kept: Override = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== field),
  );
  const next: Override =
    value === "" || value === session[field] ? kept : { ...kept, [field]: value };
  const overrides = Object.keys(next).length === 0 ? others : { ...others, [session.id]: next };
  return { ...node, settings: { ...node.settings, overrides } };
}
