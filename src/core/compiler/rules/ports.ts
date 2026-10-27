import type { Node, Port } from "../../flow/schema.js";
import { registry } from "../../nodes/registry.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "ports";

const hasPort = (node: Node, name: string, direction: Port["direction"]) => {
  const ports: readonly Port[] = registry[node.type].ports;
  return ports.some((port) => port.name === name && port.direction === direction);
};

export const rule: Rule = {
  id,
  message: "A wire must leave from an output port and arrive at an input port of its node's type.",
  check: (flow) => {
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));
    return flow.wires.flatMap((wire, index): ValidationError[] => {
      const from = byId.get(wire.from.node);
      const to = byId.get(wire.to.node);
      if (from === undefined || to === undefined) return [];
      const errors: ValidationError[] = [];
      if (!hasPort(from, wire.from.port, "out")) {
        errors.push({
          rule: id,
          wire: index,
          node: from.id,
          message: `${from.type} "${from.id}" has no output port "${wire.from.port}".`,
        });
      }
      if (!hasPort(to, wire.to.port, "in")) {
        errors.push({
          rule: id,
          wire: index,
          node: to.id,
          message: `${to.type} "${to.id}" has no input port "${wire.to.port}".`,
        });
      }
      return errors;
    });
  },
};
