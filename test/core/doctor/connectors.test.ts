import { describe, expect, it } from "vitest";
import { diagnoseConnectors, doctorReportSchema } from "../../../src/core/doctor/connectors.js";

const secret = "xoxb-very-secret-value";

const installed = {
  slack: { command: "npx", args: ["slack-mcp"], env: { SLACK_TOKEN: secret, SLACK_TEAM: "T1" } },
  jira: { type: "http", url: "https://mcp.example.com/jira", headers: { Authorization: "" } },
  github: { command: "gh-mcp", env: { GITHUB_TOKEN: "   " } },
  broken: { args: ["x"] },
};

describe("diagnoseConnectors", () => {
  it("reports only the installed connectors, by name, with each setting only as set or empty", () => {
    const report = diagnoseConnectors(installed);

    expect(report).toEqual({
      installed: [
        {
          name: "broken",
          status: "missing-setting",
          settings: [{ name: "command or url", set: false }],
        },
        {
          name: "github",
          status: "missing-setting",
          settings: [{ name: "GITHUB_TOKEN", set: false }],
        },
        {
          name: "jira",
          status: "missing-setting",
          settings: [{ name: "Authorization", set: false }],
        },
        {
          name: "slack",
          status: "ok",
          settings: [
            { name: "SLACK_TOKEN", set: true },
            { name: "SLACK_TEAM", set: true },
          ],
        },
      ],
    });
  });

  it("never carries a setting's value", () => {
    const report = diagnoseConnectors(installed);

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("T1");
    expect(JSON.stringify(report)).not.toContain("mcp.example.com");
    expect(doctorReportSchema.parse(report)).toEqual(report);
  });
});
