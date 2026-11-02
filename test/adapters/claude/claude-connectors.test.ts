import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeUserConnectors } from "../../../src/adapters/claude/claude-connectors.js";

describe("ClaudeUserConnectors", () => {
  let folder: string;
  let configPath: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-connectors-"));
    configPath = join(folder, ".claude.json");
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("finds a user-scope MCP server by name, exactly as Claude Code holds it", async () => {
    const jira = { type: "stdio", command: "npx", args: ["jira-mcp"], env: { TOKEN: "t" } };
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { jira },
        projects: { "/repo": { mcpServers: { local: { type: "http", url: "https://l" } } } },
      }),
    );
    const connectors = new ClaudeUserConnectors({ configPath });

    expect(await connectors.find("jira")).toEqual(jira);
    expect(await connectors.find("local")).toBeUndefined();
    expect(await connectors.find("toString")).toBeUndefined();
  });

  it("finds nothing when Claude Code has no config file or no servers", async () => {
    expect(await new ClaudeUserConnectors({ configPath }).find("jira")).toBeUndefined();

    await writeFile(configPath, JSON.stringify({ projects: {} }));
    expect(await new ClaudeUserConnectors({ configPath }).find("jira")).toBeUndefined();
  });

  it("rejects a config file that is not JSON, naming the file", async () => {
    await writeFile(configPath, "{ not json");

    await expect(new ClaudeUserConnectors({ configPath }).find("jira")).rejects.toThrow(configPath);
  });

  it("names only the file and where the JSON breaks, never a slice of what it holds", async () => {
    const secret = "xoxbQZSECRETVALUE";
    await writeFile(
      configPath,
      `{"mcpServers":{"slack":{"command":"x","env":{"SLACK_TOKEN":${secret}}}}}`,
    );
    const unquoted = await new ClaudeUserConnectors({ configPath }).list().catch((e: Error) => e);
    await writeFile(configPath, '{"a":1,\n"b": "open');
    const unterminated = await new ClaudeUserConnectors({ configPath }).list().catch((e) => e);

    expect(unquoted).toEqual(new Error(`${configPath} is not valid JSON`));
    expect((unquoted as Error).cause).toBeUndefined();
    const shown = (unquoted as Error).message.replace(configPath, "");
    const slices = [...secret]
      .map((_, at) => secret.slice(at, at + 3))
      .filter((s) => s.length === 3);
    expect(slices.filter((slice) => shown.includes(slice))).toEqual([]);
    expect(unterminated).toEqual(new Error(`${configPath} is not valid JSON (line 2, column 11)`));
  });

  it("lists every user-scope MCP server, and none without a config file", async () => {
    expect(await new ClaudeUserConnectors({ configPath }).list()).toEqual({});

    const jira = { type: "http", url: "https://j" };
    const slack = { command: "slack-mcp", env: { SLACK_TOKEN: "" } };
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { jira, slack, odd: "not a server" },
        projects: { "/repo": { mcpServers: { local: { type: "http", url: "https://l" } } } },
      }),
    );

    expect(await new ClaudeUserConnectors({ configPath }).list()).toEqual({ jira, slack });
  });
});
