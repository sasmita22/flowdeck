type HookEntry = { hooks: { type: "command"; command: string }[] }[];

export type BlueprintSessionSettings = {
  permissions: { allow: string[]; deny: string[] };
  hooks: { Stop: HookEntry };
};

export const BLUEPRINT_SESSION_ALLOWED: readonly string[] = [
  "Skill",
  "Read",
  "Glob",
  "Grep",
  "mcp__flowdeck__*",
];

export const BLUEPRINT_SESSION_DENIED: readonly string[] = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
];

export function blueprintSessionName(flowId: string): string {
  return `fd-bp-${flowId}`;
}

export function blueprintSessionFolder(home: string, flowId: string): string {
  return `${home}/bp-sessions/${flowId}`;
}

export function blueprintSocketPath(home: string): string {
  return `${home}/sockets/bp.sock`;
}

function databaseRule(home: string): string {
  return `Read(/${home}/flowdeck.db*)`;
}

export function blueprintSessionSettings(options: {
  home: string;
  hookCommand: string;
}): BlueprintSessionSettings {
  return {
    permissions: {
      allow: [...BLUEPRINT_SESSION_ALLOWED],
      deny: [...BLUEPRINT_SESSION_DENIED, databaseRule(options.home)],
    },
    hooks: { Stop: [{ hooks: [{ type: "command", command: options.hookCommand }] }] },
  };
}
