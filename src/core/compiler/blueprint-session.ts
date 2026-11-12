type HookEntry = { matcher?: string; hooks: { type: "command"; command: string }[] }[];

export type BlueprintSessionSettings = {
  permissions: { allow: string[]; deny: string[]; defaultMode: "dontAsk" };
  hooks: { Stop: HookEntry; PreToolUse: HookEntry };
};

export type GithubMcpServer = {
  type: "http";
  url: string;
  headers: { Authorization: string };
};

export const GITHUB_READ_TOOLS: readonly string[] = [
  "get_commit",
  "get_file_contents",
  "get_latest_release",
  "get_release_by_tag",
  "get_tag",
  "list_branches",
  "list_commits",
  "list_releases",
  "list_repository_collaborators",
  "list_tags",
  "search_code",
  "search_commits",
  "search_repositories",
];

export const BLUEPRINT_SESSION_ALLOWED: readonly string[] = [
  "Skill",
  "Read",
  "Glob",
  "Grep",
  "mcp__flowdeck__*",
  "WebFetch(domain:github.com)",
  "WebFetch(domain:raw.githubusercontent.com)",
  ...GITHUB_READ_TOOLS.map((tool) => `mcp__github__${tool}`),
];

export const BLUEPRINT_SESSION_DENIED: readonly string[] = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
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
  webGuardCommand: string;
}): BlueprintSessionSettings {
  return {
    permissions: {
      allow: [...BLUEPRINT_SESSION_ALLOWED],
      deny: [...BLUEPRINT_SESSION_DENIED, databaseRule(options.home)],
      defaultMode: "dontAsk",
    },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: options.hookCommand }] }],
      PreToolUse: [
        { matcher: "WebFetch", hooks: [{ type: "command", command: options.webGuardCommand }] },
      ],
    },
  };
}

export function githubMcpServer(token: string): GithubMcpServer {
  return {
    type: "http",
    url: "https://api.githubcopilot.com/mcp/x/repos/readonly",
    headers: { Authorization: `Bearer ${token}` },
  };
}
