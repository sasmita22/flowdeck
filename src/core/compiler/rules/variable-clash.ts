import { labelOf } from "../../flow/labels.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "variable-clash";

type Claim = { holder: string; fromLibrary: boolean };

export const rule: Rule = {
  id,
  message:
    "A library cannot send up a variable this blueprint already has, from its own Branch or another library.",
  check: (flow, context) => {
    const claims = new Map<string, Claim>();
    return flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type === "branch" && node.settings.variable !== "") {
        const { variable } = node.settings;
        const earlier = claims.get(variable);
        if (earlier === undefined)
          claims.set(variable, { holder: labelOf(flow, node.id), fromLibrary: false });
        if (earlier?.fromLibrary !== true) return [];
        return [
          {
            rule: id,
            node: node.id,
            field: "variable",
            message: `${labelOf(flow, node.id)} names "${variable}", which ${earlier.holder} already sends up; name another variable.`,
          },
        ];
      }
      if (node.type !== "library") return [];
      const sends = context?.libraries(node.settings.libraryId)?.sends ?? [];
      const clashes = sends.flatMap((name) => {
        const earlier = claims.get(name);
        return earlier === undefined ? [] : [{ name, earlier }];
      });
      for (const name of sends) {
        if (!claims.has(name)) claims.set(name, { holder: node.settings.label, fromLibrary: true });
      }
      return clashes.map(({ name, earlier }) => ({
        rule: id,
        node: node.id,
        message: `${node.settings.label} sends up "${name}", which ${earlier.holder} already has; rename it in one of them.`,
      }));
    });
  },
};
