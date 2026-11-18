export type McpServer = Record<string, unknown>;

export interface ConnectorSource {
  list(): Promise<Record<string, McpServer>>;
}
