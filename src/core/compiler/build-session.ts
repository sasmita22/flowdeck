type HookEntry = {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
}[];

export type BuildSessionSettings = {
  permissions: { allow: string[]; deny: string[]; defaultMode: string };
  hooks: {
    PreToolUse: HookEntry;
    PermissionRequest: HookEntry;
    PostToolUse: HookEntry;
    SubagentStop: HookEntry;
    Stop: HookEntry;
  };
};

export const BUILD_SESSION_DENIED: readonly string[] = [
  "Bash",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Skill",
  "TodoWrite",
];

const BUILD_SESSION_ALLOWED: readonly string[] = ["Read", "Edit", "Glob", "Grep", "Agent"];

export function buildSessionSettings(commands: {
  guardCommand: string;
  hookCommand: string;
}): BuildSessionSettings {
  const forward = (): HookEntry => [
    { hooks: [{ type: "command", command: commands.hookCommand }] },
  ];
  return {
    permissions: {
      allow: [...BUILD_SESSION_ALLOWED],
      deny: [...BUILD_SESSION_DENIED],
      defaultMode: "default",
    },
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: commands.guardCommand }] }, ...forward()],
      PermissionRequest: [
        { matcher: "Edit", hooks: [{ type: "command", command: commands.guardCommand }] },
      ],
      PostToolUse: forward(),
      SubagentStop: forward(),
      Stop: forward(),
    },
  };
}

export function newBuildSessionName(random: () => string): string {
  return `fd-build-${random()
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8)}`;
}
