import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findNode } from "./hooks.js";

export type McpScript = { nodePath: string; scriptPath: string };

const scriptName = "flowdeck-mcp.cjs";

export function prepareMcpScript(options: {
  bundleDir: string;
  home: string;
  path: string | undefined;
}): McpScript {
  const nodePath = findNode(options.path);
  if (nodePath === undefined) {
    throw new Error("No executable node found on PATH; the blueprint tools need it");
  }
  const script = readFileSync(join(options.bundleDir, scriptName));
  const mcpDir = join(options.home, "mcp");
  const scriptPath = join(mcpDir, scriptName);
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(scriptPath, script);
  return { nodePath, scriptPath };
}
