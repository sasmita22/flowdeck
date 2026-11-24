import { labelPrefix } from "../../flow/libraries.js";
import type { Node } from "../../flow/schema.js";
import { safeName } from "../../flow/variables.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "library-labels";

type LibraryNode = Extract<Node, { type: "library" }>;

export const rule: Rule = {
  id,
  message:
    "Each library node needs a label of letters, digits, spaces, dashes and underscores that no other library node uses.",
  check: ({ nodes }): ValidationError[] => {
    const uses = nodes.filter((node): node is LibraryNode => node.type === "library");
    const counts = new Map<string, number>();
    for (const use of uses) {
      const prefix = labelPrefix(use.settings.label);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return uses.flatMap((use): ValidationError[] => {
      const { label } = use.settings;
      const prefix = labelPrefix(label);
      if (!safeName.test(prefix)) {
        return [
          {
            rule: id,
            node: use.id,
            field: "label",
            message: `"${label}" cannot name a library; use letters, digits, spaces, dashes and underscores.`,
          },
        ];
      }
      if ((counts.get(prefix) ?? 0) > 1) {
        return [
          {
            rule: id,
            node: use.id,
            field: "label",
            message: `Another library node is also labelled "${prefix}" once spaces and capitals are evened out.`,
          },
        ];
      }
      return [];
    });
  },
};
