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
});
