import type { Flow } from "../../src/core/flow/schema.js";
import {
  agent,
  ask,
  branch,
  forEach,
  fork,
  gate,
  hardstop,
  join,
  loop,
  output,
  sessionLibrary,
  thenWire,
  trigger,
  wire,
} from "./flow-builders.js";

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const lettered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${String.fromCharCode(97 + index)}`);

const agents = (list: readonly string[], parent?: string) =>
  list.map((id) => agent(id, parent === undefined ? {} : { parent }));

const chained = (list: readonly string[]) =>
  list.slice(1).map((id, index) => thenWire(list[index] ?? "", id));

const head = ids("a", 6);
const yes = ids("y", 4);
const no = ids("n", 2);
const loop1 = lettered("l1", 3);
const middle = ids("a", 10).slice(6);
const paths = ids("p", 4);
const each = ids("e", 4);
const loop2 = lettered("l2", 3);
const loop3 = lettered("l3", 4);
const tail = ids("a", 16).slice(10);

const nodes = [
  trigger("start"),
  ...agents(head),
  gate("g1"),
  ask("q1"),
  branch("b1", "approved"),
  ...agents(yes),
  agent("r1"),
  ...agents(no),
  output("stop"),
  loop("L1"),
  ...agents(loop1, "L1"),
  ...agents(middle),
  gate("g2"),
  fork("F"),
  ...agents(paths),
  join("J"),
  forEach("E"),
  ...agents(each, "E"),
  loop("L2"),
  ...agents(loop2, "L2"),
  loop("L3"),
  ...agents(loop3, "L3"),
  gate("g3"),
  ...agents(tail),
  ask("q2"),
  gate("g4"),
  branch("b2", "shipped"),
  hardstop("h1"),
];

const wires = [
  ...chained(["start", ...head, "g1", "q1", "b1"]),
  wire("b1", "yes", "y1", "in"),
  ...chained([...yes, "r1", ...loop1, ...middle, "g2", "F"]),
  wire("b1", "no", "n1", "in"),
  ...chained([...no, "stop"]),
  ...paths.flatMap((path) => chained(["F", path, "J"])),
  ...chained(["J", ...each, ...loop2, ...loop3, "g3", ...tail, "q2", "g4", "b2"]),
  wire("b2", "yes", "stop", "in"),
  wire("b2", "no", "h1", "in"),
];

export const featureLibrary: Flow = sessionLibrary(nodes, wires);
