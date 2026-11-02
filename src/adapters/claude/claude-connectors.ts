import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorSource, McpServer } from "../../ports/connector-source.js";
import type { FileSystem } from "../../ports/file-system.js";
import { hasCode } from "./claude-cli.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class ClaudeUserConnectors implements ConnectorSource {
  private readonly configPath: string;

  constructor(options: { configPath?: string } = {}) {
    this.configPath = options.configPath ?? join(homedir(), ".claude.json");
  }

  async find(name: string): Promise<McpServer | undefined> {
    const servers = (await this.config())["mcpServers"];
    if (!isRecord(servers) || !Object.hasOwn(servers, name)) return undefined;
    const server = servers[name];
    return isRecord(server) ? server : undefined;
  }

  private async config(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return {};
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? parsed : {};
    } catch (error) {
      throw new Error(
        `${this.configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

export async function writeSessionMcpConfig(
  fs: Pick<FileSystem, "writePrivateFile">,
  path: string,
  servers: Record<string, McpServer>,
): Promise<{ mcpConfigPath?: string }> {
  if (Object.keys(servers).length === 0) return {};
  await fs.writePrivateFile(path, JSON.stringify({ mcpServers: servers }));
  return { mcpConfigPath: path };
}
