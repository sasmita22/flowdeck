import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/repo-required.js";
import { type Session } from "../../../../src/core/flow/schema.js";
import { agent, flow } from "../../../fixtures/flow-builders.js";

const withConfig = (buildConfig: Session["buildConfig"]) => {
  const base = flow([agent("p")], []);
  return { ...base, session: { ...base.session, buildConfig } };
};

const asError = [{ rule: "repo-required", field: "buildConfig.repo" }];

const errorsOf = (input: ReturnType<typeof withConfig>) =>
  rule.check(input).map(({ rule, field }) => ({ rule, field }));

describe("repo-required", () => {
  it.each([
    ["no repository", { base: "main" }],
    ["an empty repository", { repo: "", base: "main" }],
  ])("refuses a flow with %s", (_, buildConfig) => {
    expect(errorsOf(withConfig(buildConfig))).toEqual(asError);
  });

  it("accepts a flow with a repository", () => {
    expect(rule.check(withConfig({ repo: "/work/repo", base: "main" }))).toEqual([]);
  });
});
