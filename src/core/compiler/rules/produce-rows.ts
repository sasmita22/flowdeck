import { labelOf } from "../../flow/labels.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "produce-rows";

const missing = (row: { yesIf: string; noIf: string }): string[] => [
  ...(row.yesIf.trim() === "" ? ["Yes if"] : []),
  ...(row.noIf.trim() === "" ? ["No if"] : []),
];

export const rule: Rule = {
  id,
  message:
    "Each variable an Agent produces names the variable and says when it is yes and when no.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "agent") return [];
      const agent = labelOf(flow, node.id);
      return (node.settings.produces ?? []).flatMap((row): ValidationError[] => {
        if (row.variable === "") {
          return [
            {
              rule: id,
              node: node.id,
              field: "produces",
              message: `${agent} has a produced variable with no name picked; pick one.`,
            },
          ];
        }
        const empty = missing(row);
        if (empty.length === 0) return [];
        return [
          {
            rule: id,
            node: node.id,
            field: "produces",
            message: `${agent} produces "${row.variable}" with no ${empty.join(" and no ")}; say when it is yes and when it is no.`,
          },
        ];
      });
    }),
};
