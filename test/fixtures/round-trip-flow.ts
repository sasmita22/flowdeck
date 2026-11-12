import { readFileSync } from "node:fs";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";

type RawFlow = {
  nodes: { id: string; type: string; settings: Record<string, unknown> }[];
  wires: {
    kind: string;
    from: { node: string; port: string };
    to: { node: string; port: string };
  }[];
};

export function roundTripFlow(): Flow {
  const flow = JSON.parse(
    readFileSync(new URL("../../examples/all-types.json", import.meta.url), "utf8"),
  ) as RawFlow;

  const settingsOf = (id: string) => {
    const node = flow.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) throw new Error(`all-types.json has no ${id} node`);
    return node.settings;
  };
  settingsOf("plan").expectedOutput = "plan.md with numbered steps";
  settingsOf("plan").writes = ["plan.md"];
  settingsOf("build").given = ["plan.md"];
  settingsOf("lint").produces = "clean";
  flow.nodes.push({
    id: "ifclean",
    label: "Clean?",
    type: "branch",
    position: { x: 1500, y: 60 },
    settings: { decidedBy: "value", variable: "", value: "clean" },
  } as RawFlow["nodes"][number]);
  flow.wires = flow.wires.flatMap((wire) =>
    wire.from.node === "lint" && wire.to.node === "ife2e"
      ? ["yes", "no"].map((port) => ({
          kind: "then",
          from: { node: "ifclean", port },
          to: wire.to,
        }))
      : [wire],
  );
  flow.wires.push({
    kind: "then",
    from: { node: "lint", port: "out" },
    to: { node: "ifclean", port: "in" },
  });
  flow.wires.push({
    kind: "event",
    from: { node: "choose", port: "out" },
    to: { node: "done", port: "in" },
  });

  return parseFlow(flow);
}
