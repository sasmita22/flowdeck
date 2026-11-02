import { describe, expect, it } from "vitest";
import { plainReason } from "../../../src/core/run/failure.js";

describe("plainReason", () => {
  it.each([
    ["s2 failed: exit code 3", "Script exited with code 3"],
    ["s2 failed: killed by a signal", "Script was stopped by a signal"],
    ["s2 failed: rejected: wrong scope", "Rejected: wrong scope"],
    ["s2 failed: The run was stopped", "The run was stopped"],
    ["l1 failed: s2 failed: exit code 3", "s2 failed: Script exited with code 3"],
    ["no prefix at all", "No prefix at all"],
  ])("says %j as %j", (message, plain) => {
    expect(plainReason(message.split(" ")[0] ?? "", message)).toBe(plain);
  });
});
