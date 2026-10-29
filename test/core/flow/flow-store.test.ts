import { describe, expect, it } from "vitest";
import { saveFlowResultSchema } from "../../../src/core/flow/flow-store.js";

describe("saveFlowResultSchema", () => {
  it.each([
    { kind: "saved", flowId: "f1", version: 3 },
    { kind: "error", message: "disk full" },
  ])("accepts a $kind result", (result) => {
    expect(saveFlowResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    ["no kind", { flowId: "f1", version: 1 }],
    ["an unknown kind", { kind: "loaded", flowId: "f1", version: 1 }],
    ["a non-number version", { kind: "saved", flowId: "f1", version: "1" }],
    ["a missing flow id", { kind: "saved", version: 1 }],
    ["an error without a message", { kind: "error" }],
    ["null", null],
    ["a string", "saved"],
  ])("rejects %s", (_, input) => {
    expect(saveFlowResultSchema.safeParse(input).success).toBe(false);
  });
});
