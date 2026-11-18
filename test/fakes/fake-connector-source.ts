import type { ConnectorSource, McpServer } from "../../src/ports/connector-source.js";

export class FakeConnectorSource implements ConnectorSource {
  private readonly servers: Record<string, McpServer>;

  constructor(servers: Record<string, McpServer> = {}) {
    this.servers = structuredClone(servers);
  }

  async list(): Promise<Record<string, McpServer>> {
    return structuredClone(this.servers);
  }
}
