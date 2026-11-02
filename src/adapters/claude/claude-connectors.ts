import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorSource, McpServer } from "../../ports/connector-source.js";
import type { FileSystem } from "../../ports/file-system.js";
import { hasCode } from "./claude-cli.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false; where: string } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const at = /\(line (\d+) column (\d+)\)/.exec(error instanceof Error ? error.message : "");
    return { ok: false, where: at === null ? "" : ` (line ${at[1]}, column ${at[2]})` };
  }
};

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

  async list(): Promise<Record<string, McpServer>> {
    const servers = (await this.config())["mcpServers"];
    if (!isRecord(servers)) return {};
    return Object.fromEntries(
      Object.entries(servers).filter((entry): entry is [string, McpServer] => isRecord(entry[1])),
    );
  }

  private async config(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return {};
      throw error;
    }
    const parsed = parseJson(text);
    if (!parsed.ok) throw new Error(`${this.configPath} is not valid JSON${parsed.where}`);
    return isRecord(parsed.value) ? parsed.value : {};
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
