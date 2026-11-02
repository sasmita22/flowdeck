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
  it("lists every installed connector by name with each setting only as set or empty", () => {
    const report = diagnoseConnectors(installed, []);

    expect(report.installed).toEqual([
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
    ]);
    expect(report.needed).toEqual([]);
  });

  it("marks each needed connector installed, missing with how to add it, or missing a setting", () => {
    const { needed } = diagnoseConnectors(installed, ["slack", "linear", "jira"]);

    expect(needed).toEqual([
      {
        name: "slack",
        status: "ok",
        settings: [
          { name: "SLACK_TOKEN", set: true },
          { name: "SLACK_TEAM", set: true },
        ],
        fix: null,
      },
      {
        name: "linear",
        status: "missing",
        settings: [],
        fix: "Add it for your user with `claude mcp add --scope user linear …`, then build again.",
      },
      {
        name: "jira",
        status: "missing-setting",
        settings: [{ name: "Authorization", set: false }],
        fix: 'Fill in Authorization for "jira" under "mcpServers" in ~/.claude.json, then build again.',
      },
    ]);
  });

  it("never carries a setting's value", () => {
    const report = diagnoseConnectors(installed, ["slack"]);

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("T1");
    expect(JSON.stringify(report)).not.toContain("mcp.example.com");
    expect(doctorReportSchema.parse(report)).toEqual(report);
  });
});
