import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/session-connections.js";
import type { Flow } from "../../../../src/core/flow/schema.js";
import { sessionsWorkflow } from "../../../fixtures/flow-builders.js";

const android = "session-1";
const ios = "session-2";
const workspace = "workspace-1";
const node = "session-2-start";

const connected = (...pairs: [string, string][]): Flow => ({
  ...sessionsWorkflow([
    { name: "android", repo: "/repos/android", branch: "main" },
    { name: "ios", repo: "/repos/ios", branch: "main" },
  ]),
  connections: pairs.map((between, index) => ({ id: `c${index + 1}`, between })),
});

const errorsOf = (flow: Flow) =>
  rule.check(flow).map(({ rule, container }) => ({ rule, container }));

const refusedAt = (container: string) => [{ rule: "session-connections", container }];

describe("session-connections", () => {
  it("accepts a connection between two session containers", () => {
    expect(rule.check(connected([android, ios]))).toEqual([]);
  });

  it("accepts a flow without connections", () => {
    expect(rule.check(connected())).toEqual([]);
  });

  it.each([
    ["the workspace second", [android, workspace]],
    ["the workspace first", [workspace, android]],
    ["a node second", [android, node]],
    ["a node first", [node, android]],
    ["an unknown id second", [android, "missing"]],
    ["an unknown id first", ["missing", android]],
  ] as const)("refuses a connection with %s, on its session end", (_name, between) => {
    expect(errorsOf(connected([...between]))).toEqual(refusedAt(android));
  });

  it("refuses a session connected to itself", () => {
    expect(errorsOf(connected([android, android]))).toEqual(refusedAt(android));
  });

  it("refuses a second connection between the same pair", () => {
    expect(errorsOf(connected([android, ios], [android, ios]))).toEqual(refusedAt(android));
  });

  it("refuses the reversed connection after the first", () => {
    expect(errorsOf(connected([android, ios], [ios, android]))).toEqual(refusedAt(ios));
  });
});
