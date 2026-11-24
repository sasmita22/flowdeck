import { flowContainerName, flowContainerOf } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "container-wires";

export const rule: Rule = {
  id,
  message:
    "A wire stays inside its workspace or session, or at canvas level; it enters a container only at its flow-in and leaves only from its flow-out.",
  check: (flow): ValidationError[] => {
    const labels = new Map(flow.nodes.map((node) => [node.id, node.label]));
    return flow.wires.flatMap((wire, index): ValidationError[] => {
      const fromLabel = labels.get(wire.from.node);
      const toLabel = labels.get(wire.to.node);
      if (fromLabel === undefined || toLabel === undefined) return [];
      const from = flowContainerOf(flow, wire.from.node);
      const to = flowContainerOf(flow, wire.to.node);
      const crossed = from?.id === to?.id ? undefined : (to ?? from);
      if (crossed === undefined) return [];
      return [
        {
          rule: id,
          wire: index,
          node: wire.to.node,
          message: `The wire from ${fromLabel} to ${toLabel} crosses a container's edge. ${flowContainerName(crossed)} is entered only through its flow-in and left only through its flow-out. Delete the wire on the canvas.`,
        },
      ];
    });
  },
};
