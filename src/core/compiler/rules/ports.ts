import type { FlowContainer, Node, Port, Wire } from "../../flow/schema.js";
import { flowContainerName, flowIn, flowOut } from "../../flow/structure.js";
import { registry } from "../../nodes/registry.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "ports";

const portOf = (node: Node, name: string, direction: Port["direction"]) => {
  const ports: readonly Port[] = registry[node.type].ports;
  return ports.find((port) => port.name === name && port.direction === direction);
};

const kindName = (kind: Wire["kind"]) => `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;

const portRole = (direction: Port["direction"]) => (direction === "out" ? "output" : "input");

const nodeEnd = (
  node: Node,
  wire: Wire,
  index: number,
  name: string,
  direction: Port["direction"],
): ValidationError[] => {
  const port = portOf(node, name, direction);
  const error = (message: string) => [{ rule: id, wire: index, node: node.id, message }];
  if (port === undefined) {
    return error(`${node.type} "${node.id}" has no ${portRole(direction)} port "${name}".`);
  }
  if (port.kind !== wire.kind) {
    return error(
      `${node.type} "${node.id}" port "${name}" takes ${kindName(port.kind)} wires, not ${kindName(wire.kind)} wires.`,
    );
  }
  return [];
};

const containerEnd = (
  container: FlowContainer,
  wire: Wire,
  index: number,
  name: string,
  direction: Port["direction"],
): ValidationError[] => {
  const error = (message: string) => [{ rule: id, wire: index, container: container.id, message }];
  if (name !== (direction === "out" ? flowOut : flowIn)) {
    return error(`${flowContainerName(container)} has no ${portRole(direction)} port "${name}".`);
  }
  if (wire.kind !== "then") {
    return error(
      `${flowContainerName(container)} port "${name}" takes Then wires, not ${kindName(wire.kind)} wires.`,
    );
  }
  return [];
};

export const rule: Rule = {
  id,
  message:
    "A wire must leave from an output port and arrive at an input port of its node's type, and both ports must take its kind of wire.",
  check: (flow) => {
    const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
    const containers = new Map(flow.containers.map((container) => [container.id, container]));
    return flow.wires.flatMap((wire, index): ValidationError[] => {
      const known = (end: "from" | "to") =>
        nodes.has(wire[end].node) || containers.has(wire[end].node);
      if (!known("from") || !known("to")) return [];
      const end = (side: "from" | "to", direction: Port["direction"]) => {
        const { node: endId, port } = wire[side];
        const node = nodes.get(endId);
        if (node !== undefined) return nodeEnd(node, wire, index, port, direction);
        const container = containers.get(endId);
        return container === undefined ? [] : containerEnd(container, wire, index, port, direction);
      };
      return [...end("from", "out"), ...end("to", "in")];
    });
  },
};
