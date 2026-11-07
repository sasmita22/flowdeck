import type { Rule, ValidationError } from "../validate.js";

const id = "agent-tools";

export const rule: Rule = {
  id,
  message: "An Agent can only ask for tools the session's allowed tools include.",
  check: (flow) => {
    const allowed = new Set(flow.session.allowedTools);
    return flow.nodes.flatMap((node): ValidationError[] =>
      node.type !== "agent"
        ? []
        : node.settings.tools
            .filter((tool) => !allowed.has(tool))
            .map((tool) => ({
              rule: id,
              node: node.id,
              field: "tools",
              message: `${node.id} asks for ${tool}, which the session's allowed tools do not include.`,
            })),
    );
  },
};
