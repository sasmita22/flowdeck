import type { PendingWait, WaitRequest } from "../../src/core/run/wait.js";

export const gate: WaitRequest = { nodeId: "g1", kind: "gate", instruction: "Check the plan" };

export const conditionalGate: WaitRequest = {
  nodeId: "h1",
  kind: "gate",
  instruction: "Read the test report",
  condition: "tests fail",
};

export const permission: WaitRequest = {
  nodeId: "n1",
  kind: "permission",
  tool: "Bash",
  input: "echo hi",
};

export const pick: WaitRequest = {
  nodeId: "q",
  kind: "ask",
  question: "Pick a colour",
  options: ["red", "blue", "green"],
};

export const free: WaitRequest = { nodeId: "q2", kind: "ask", question: "Name it", options: [] };

export const gateWait: PendingWait = {
  waitId: "wait-1",
  request: { nodeId: "gate", kind: "gate", instruction: "Ship it?" },
};

export const askWait: PendingWait = {
  waitId: "wait-2",
  request: { nodeId: "ask", kind: "ask", question: "Colour?", options: ["red", "blue"] },
};
