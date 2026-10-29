import { readFileSync } from "node:fs";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";

type RawFlow = {
  nodes: { id: string; type: string; settings: Record<string, unknown> }[];
  wires: unknown[];
};

export function roundTripFlow(): Flow {
  const flow = JSON.parse(
    readFileSync(new URL("../../examples/all-types.json", import.meta.url), "utf8"),
  ) as RawFlow;

  const plan = flow.nodes.find((node) => node.id === "plan");
  if (plan === undefined) throw new Error("all-types.json has no plan node");
  plan.settings.expectedOutput = "plan.md with numbered steps";
  flow.wires.push(
    {
      kind: "file",
      from: { node: "plan", port: "out" },
      to: { node: "build", port: "in" },
      file: "plan.md",
    },
    {
      kind: "event",
      from: { node: "choose", port: "out" },
      to: { node: "done", port: "in" },
    },
  );

  return parseFlow(flow);
}
