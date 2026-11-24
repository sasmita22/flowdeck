import type { Rule, ValidationError } from "../validate.js";

const id = "session-connections";

export const rule: Rule = {
  id,
  message: "A connection joins two different session containers, once per pair.",
  check: ({ containers, connections = [] }): ValidationError[] => {
    const sessions = new Set(
      containers.filter((container) => container.kind === "session").map(({ id }) => id),
    );
    const seen = new Set<string>();
    return connections.flatMap(({ between }): ValidationError[] => {
      const container = between.find((end) => sessions.has(end));
      const refuse = (message: string): ValidationError[] => [
        { rule: id, message, ...(container === undefined ? {} : { container }) },
      ];
      if (!between.every((end) => sessions.has(end))) {
        return refuse("A connection can only join two session containers.");
      }
      const [first, second] = between;
      if (first === second) return refuse("A session cannot connect to itself.");
      const pair = [first, second].sort().join("\n");
      if (seen.has(pair)) return refuse("These sessions are already connected.");
      seen.add(pair);
      return [];
    });
  },
};
