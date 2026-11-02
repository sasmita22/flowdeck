import type { Node, Port, Wire } from "../../flow/schema.js";
import { registry } from "../../nodes/registry.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "ports";

const portOf = (node: Node, name: string, direction: Port["direction"]) => {
  const ports: readonly Port[] = registry[node.type].ports;
  return ports.find((port) => port.name === name && port.direction === direction);
};

const kindName = (kind: Wire["kind"]) => `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;

export const rule: Rule = {
  id,
  message:
    "A wire must leave from an output port and arrive at an input port of its node's type, and both ports must take its kind of wire.",
  check: (flow) => {
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));
    return flow.wires.flatMap((wire, index): ValidationError[] => {
      const from = byId.get(wire.from.node);
      const to = byId.get(wire.to.node);
      if (from === undefined || to === undefined) return [];
      const end = (node: Node, name: string, direction: Port["direction"]): ValidationError[] => {
        const port = portOf(node, name, direction);
        const error = (message: string) => [{ rule: id, wire: index, node: node.id, message }];
        if (port === undefined) {
          return error(
            `${node.type} "${node.id}" has no ${direction === "out" ? "output" : "input"} port "${name}".`,
          );
        }
        if (port.kind !== wire.kind) {
          return error(
            `${node.type} "${node.id}" port "${name}" takes ${kindName(port.kind)} wires, not ${kindName(wire.kind)} wires.`,
          );
        }
        return [];
      };
      return [...end(from, wire.from.port, "out"), ...end(to, wire.to.port, "in")];
    });
  },
};
