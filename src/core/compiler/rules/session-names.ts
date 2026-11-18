import type { Rule, ValidationError } from "../validate.js";

const id = "session-names";

export const rule: Rule = {
  id,
  message: "Each session needs a name no other session uses.",
  check: ({ containers }): ValidationError[] => {
    const seen = new Set<string>();
    return containers.flatMap((container): ValidationError[] => {
      if (container.kind !== "session") return [];
      if (container.name === "") {
        return [
          { rule: id, container: container.id, field: "name", message: "A session needs a name." },
        ];
      }
      if (seen.has(container.name)) {
        return [
          {
            rule: id,
            container: container.id,
            field: "name",
            message: `Another session is already named "${container.name}".`,
          },
        ];
      }
      seen.add(container.name);
      return [];
    });
  },
};
