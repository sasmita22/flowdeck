import type { ValidationError } from "./validate.js";

export type McpServer = Record<string, unknown>;

export interface ConnectorSource {
  find(name: string): Promise<McpServer | undefined>;
  list(): Promise<Record<string, McpServer>>;
}

export type ResolvedConnectors =
  { ok: true; servers: Record<string, McpServer> } | { ok: false; errors: ValidationError[] };

const missing = (name: string): ValidationError => ({
  rule: "connectors",
  field: "connectors",
  message: `Connector "${name}" is not set up in Claude Code. Add it for your user with \`claude mcp add --scope user ${name} …\`, then build again.`,
});

export async function resolveConnectors(
  names: readonly string[],
  source: ConnectorSource | undefined,
): Promise<ResolvedConnectors> {
  const servers: Record<string, McpServer> = {};
  const errors: ValidationError[] = [];
  for (const name of names) {
    const server = await source?.find(name);
    if (server === undefined) errors.push(missing(name));
    else servers[name] = server;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, servers };
}
