import type { ConnectorSource, McpServer } from "../../src/ports/connector-source.js";

export class FakeConnectorSource implements ConnectorSource {
  readonly calls: string[] = [];
  private readonly servers: Record<string, McpServer>;

  constructor(servers: Record<string, McpServer> = {}) {
    this.servers = structuredClone(servers);
  }

  async find(name: string): Promise<McpServer | undefined> {
    this.calls.push(name);
    const server = Object.hasOwn(this.servers, name) ? this.servers[name] : undefined;
    return server === undefined ? undefined : structuredClone(server);
  }

  async list(): Promise<Record<string, McpServer>> {
    return structuredClone(this.servers);
  }
}
