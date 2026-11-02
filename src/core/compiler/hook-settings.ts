type HookEntry = { hooks: { type: "command"; command: string; timeout?: number }[] }[];

export type HookSettings = {
  hooks: {
    Stop: HookEntry;
    PreToolUse: HookEntry;
    PostToolUse: HookEntry;
    SubagentStop: HookEntry;
    StopFailure: HookEntry;
    PermissionRequest: HookEntry;
  };
};

export const permissionHookTimeoutSeconds = 86_400;

const permissionDeadlineMs = (permissionHookTimeoutSeconds - 60) * 1000;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type HookPaths = { nodePath: string; hookScriptPath: string };

const nodeVariable = "FLOWDECK_HOOK_NODE";
const scriptVariable = "FLOWDECK_HOOK_SCRIPT";

export const buildHookCommand = `"$${nodeVariable}" "$${scriptVariable}"`;

export function hookEnvironment(paths: HookPaths): Record<string, string> {
  return { [nodeVariable]: paths.nodePath, [scriptVariable]: paths.hookScriptPath };
}

export function hookCommand(paths: HookPaths): string {
  return `${shellQuote(paths.nodePath)} ${shellQuote(paths.hookScriptPath)}`;
}

export function hookSettings(command: string): HookSettings {
  const entry: HookEntry = [{ hooks: [{ type: "command", command }] }];
  const permission: HookEntry = [
    {
      hooks: [
        {
          type: "command",
          command: `${command} --permission-deadline-ms=${permissionDeadlineMs}`,
          timeout: permissionHookTimeoutSeconds,
        },
      ],
    },
  ];
  return {
    hooks: {
      Stop: entry,
      PreToolUse: entry,
      PostToolUse: entry,
      SubagentStop: entry,
      StopFailure: entry,
      PermissionRequest: permission,
    },
  };
}
